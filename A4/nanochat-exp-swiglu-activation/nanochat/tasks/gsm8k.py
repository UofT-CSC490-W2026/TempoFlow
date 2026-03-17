"""
GSM8K evaluation.
https://huggingface.co/datasets/openai/gsm8k

Example problem instance:

Question:
Weng earns $12 an hour for babysitting. Yesterday, she just did 50 minutes of babysitting. How much did she earn?
Answer:
Weng earns 12/60 = $<<12/60=0.2>>0.2 per minute.
Working 50 minutes, she earned 0.2 x 50 = $<<0.2*50=10>>10.
#### 10

Notice that GSM8K uses tool calls inside << >> tags.
"""

import re
from dataclasses import dataclass
from typing import Any, Dict
from datasets import load_dataset
from tasks.common import Task


GSM_RE = re.compile(r"#### (\-?[0-9\.\,]+)")
def extract_answer(completion):
    """
    Extract the numerical answer after #### marker.
    Follows official code for normalization:
    https://github.com/openai/grade-school-math/blob/3101c7d5072418e28b9008a6636bde82a006892c/grade_school_math/dataset.py#L28
    """
    match = GSM_RE.search(completion)
    if match:
        match_str = match.group(1).strip()
        match_str = match_str.replace(",", "")
        return match_str
    return None


@dataclass
class RewardConfig:
    answer_format: Dict[str, float] | None = None
    depth_alignment: Dict[str, float] | None = None


class GSM8K(Task):

    def __init__(self, subset, split, reward_config: RewardConfig | None = None, **kwargs):
        super().__init__(**kwargs)
        assert subset in ["main", "socratic"], "GSM8K subset must be main|socratic"
        assert split in ["train", "test"], "GSM8K split must be train|test"
        self.ds = load_dataset("openai/gsm8k", subset, split=split).shuffle(seed=42)
        self.reward_config = reward_config or RewardConfig()

    @property
    def eval_type(self):
        return 'generative'

    def num_examples(self):
        return len(self.ds)

    def get_example(self, index):
        """ Get a single problem from the dataset. """
        row = self.ds[index]
        question = row['question'] # string of the question prompt
        answer = row['answer'] # string of the full solution and the answer after #### marker
        # Create and return the Conversation object
        # This is tricky because GSM8K uses tool calls, which we need to parse here.
        assistant_message_parts = []
        parts = re.split(r'(<<[^>]+>>)', answer)
        for part in parts:
            if part.startswith('<<') and part.endswith('>>'):
                # This is a calculator tool call
                inner = part[2:-2]  # Remove << >>
                # Split on = to get expression and result
                if '=' in inner:
                    expr, result = inner.rsplit('=', 1)
                else:
                    expr, result = inner, ""
                # Add the tool call as a part
                assistant_message_parts.append({"type": "python", "text": expr})
                # Add the result as a part
                assistant_message_parts.append({"type": "python_output", "text": result})
            else:
                # Regular text in between tool calls
                assistant_message_parts.append({"type": "text", "text": part})
        # Now put it all together
        messages = [
            {"role": "user", "content": question}, # note: simple string
            {"role": "assistant", "content": assistant_message_parts}, # note: list of parts (as dicts)
        ]
        conversation = {
            "messages": messages,
        }
        return conversation

    def evaluate(self, conversation, assistant_response):
        """
        Given (conversation, completion), return evaluation outcome (0 = wrong, 1 = correct)
        Note that:
        - the conversation has both user AND assistant message (containing the ground truth answer)
        - the assistant_response is usually the alternative assistant message achieved via sampling

        TODO: Technically, assistant_response should be a Message (either a string or a list of parts)
              We can handle this later possibly. For now just assume string.
        """
        assert isinstance(assistant_response, str), "Assuming simple string response for now"
        # First extract the ground truth answer
        assistant_message = conversation['messages'][-1]
        assert assistant_message['role'] == "assistant", "Last message must be from the Assistant"
        assert isinstance(assistant_message['content'], list), "This is expected to be a list of parts"
        last_text_part = assistant_message['content'][-1]['text'] # this contains the final answer in GSM8K
        # Extract both the ground truth answer and the predicted answer
        ref_num = extract_answer(last_text_part)
        pred_num = extract_answer(assistant_response)
        # Compare and return the success as int
        is_correct = int(pred_num == ref_num)
        return is_correct

    def reward(self, conversation, assistant_response):
        """Return base correctness reward with optional shaping components."""
        base_reward = float(self.evaluate(conversation, assistant_response))
        shaped = 0.0

        if self.reward_config.answer_format:
            shaped += self._format_reward_bonus(assistant_response, base_reward)
        if self.reward_config.depth_alignment:
            shaped += self._depth_alignment_bonus(conversation, assistant_response, base_reward)

        return base_reward + shaped

    # ------------------------------------------------------------------
    # Reward helpers

    def _format_reward_bonus(self, completion: str, base_reward: float) -> float:
        cfg = self.reward_config.answer_format or {}
        bonus = cfg.get("bonus", 0.2)
        penalty = cfg.get("penalty", -0.2)
        length_pen = cfg.get("length_penalty", -0.05)
        unresolved_pen = cfg.get("unresolved_penalty", -0.1)
        max_length = int(cfg.get("max_tokens", 220))

        completion = completion.strip()
        answer = extract_answer(completion)
        ends_with_marker = False
        if answer is not None:
            ends_with_marker = completion.rstrip().endswith(f"#### {answer}")
        unresolved_calc = "[CALC" in completion or "<<" in completion

        reward_delta = 0.0
        if ends_with_marker and not unresolved_calc:
            reward_delta += bonus
        elif base_reward == 0.0:
            reward_delta += penalty

        if unresolved_calc and base_reward == 0.0:
            reward_delta += unresolved_pen

        if len(completion) > max_length and base_reward == 0.0:
            reward_delta += length_pen

        return reward_delta

    def _depth_alignment_bonus(self, conversation: Dict[str, Any], completion: str, base_reward: float) -> float:
        cfg = self.reward_config.depth_alignment or {}
        bonus = cfg.get("bonus", 0.2)
        mild_bonus = cfg.get("mild_bonus", 0.1)
        penalty = cfg.get("penalty", -0.15)

        question = conversation["messages"][0]["content"]
        target_steps = self._estimate_question_steps(question)
        completion_steps = self._estimate_completion_steps(completion)
        diff = abs(completion_steps - target_steps)

        if diff <= 1:
            return bonus
        if diff == 2 and base_reward == 1.0:
            return mild_bonus
        if diff >= 3 and base_reward == 0.0:
            return penalty
        return 0.0

    @staticmethod
    def _estimate_question_steps(question: str) -> int:
        numbers = len(re.findall(r"\d+", question))
        math_keywords = len(re.findall(r"(total|each|per|difference|product|sum|twice|triple)", question.lower()))
        estimate = max(1, min(6, (numbers // 2) + (math_keywords // 2) + 1))
        return estimate

    @staticmethod
    def _estimate_completion_steps(completion: str) -> int:
        calc_calls = completion.count("[CALC") + completion.count("<<")
        equations = len(re.findall(r"=", completion))
        line_blocks = len([line for line in completion.splitlines() if line.strip()])
        estimate = max(calc_calls, equations, line_blocks // 2)
        return max(1, min(8, estimate))
