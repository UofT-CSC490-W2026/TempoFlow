"""
AutoIF by Post-training-Data-Flywheel. Good coding tasks dataset.
https://huggingface.co/datasets/Post-training-Data-Flywheel/AutoIF-instruct-61k-with-funcs/viewer/default/train?row=0
It has 61.5k rows (no train test split).
"""

from datasets import load_dataset
from tasks.common import Task

class AutoIF(Task):
    """ AutoIF dataset. train is 61.5k rows, no test split. """

    def __init__(self, split="train", **kwargs):
        super().__init__(**kwargs)
        assert split in ["train"], "AutoIF split must be train (there is no test split)"
        self.ds = load_dataset("Post-training-Data-Flywheel/AutoIF-instruct-61k-with-funcs", split="train").shuffle(seed=42)
        self.length = len(self.ds)


    def num_examples(self):
        return self.length

    def get_example(self, index):
        row = self.ds[index]
        messages = row["messages"]
        # ---------------------------------------------------------------------
        # sanity checking asserts here
        assert len(messages) >= 1
        first_message = messages[0]
        if first_message["role"] == "system":
            rest_messages = messages[1:] 
        else:
            rest_messages = messages
        assert len(rest_messages) >= 2, "AutoIF messages must have at least 2 messages"
        for i, message in enumerate(rest_messages):
            expected_role = "user" if i % 2 == 0 else "assistant"
            assert message["role"] == expected_role, f"Message {i} has role {message['role']} but should be {expected_role}"
            assert isinstance(message["content"], str), "Content must be a string"
        # ---------------------------------------------------------------------

        conversation = {
            "messages": messages,
        }
        return conversation
