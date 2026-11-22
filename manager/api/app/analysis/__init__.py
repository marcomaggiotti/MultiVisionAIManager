"""Multi-module analysis of one picture or a sequence: YOLO pose -> ballet evaluation
and motion -> CLIP movement ranking on the dancer -> VLM answer grounded in those
measurements -> fusion of the evidence.

    options.py   defaults and request options
    context.py   the measurements written as text for the VLM
    fusion.py    one ranked list of movements with the evidence for each
    pipeline.py  the stages, calling the modules over HTTP
"""

from app.analysis.options import BALLET_STEPS, DEFAULT_OPTIONS
from app.analysis.pipeline import run_analysis

__all__ = ["BALLET_STEPS", "DEFAULT_OPTIONS", "run_analysis"]
