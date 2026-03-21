import sys
import os

current_dir = os.path.dirname(os.path.abspath(__file__))
root_path = os.path.abspath(os.path.join(current_dir, "../"))

if root_path not in sys.path:
    sys.path.insert(0, root_path)