"""
opc-sft-stage2 by OpenCoder-LLM. Good coding tasks dataset.
https://huggingface.co/datasets/OpenCoder-LLM/opc-sft-stage2/viewer/educational_instruct/train?row=0
we use the "educational_instruct" subset, which is more appropriate for smaller models. It has 118k rows (no train test split).
"""

from datasets import load_dataset
from tasks.common import Task

class OpenCoder(Task):
    """ opc-sft-stage2 dataset. train is 118k rows, no test split. """

    def __init__(self, split, **kwargs):
        super().__init__(**kwargs)
        assert split in ["train"], "OpenCoder split must be train (there is no test split)"
        self.ds = load_dataset("OpenCoder-LLM/opc-sft-stage2", "educational_instruct", split="train").shuffle(seed=42)
        self.length = len(self.ds)

    def num_examples(self):
        return self.length

    def get_example(self, index):
        row = self.ds[index]

        assert "instruction" in row, "Row must have 'instruction' field"
        assert "output" in row, "Row must have 'output' field"

        instruction = row["instruction"]
        output = row["output"]

        assert len(instruction) > 0, "Instruction must be non-empty"
        assert len(output) > 0, "Output must be non-empty"
        assert isinstance(instruction, str), "Instruction must be a string"
        assert isinstance(output, str), "Output must be a string"

        final_conversation = [
            {"role": "user", "content": instruction},
            {"role": "assistant", "content": output},
        ]
        conversation = {
            "messages": final_conversation,
        }
        return conversation
