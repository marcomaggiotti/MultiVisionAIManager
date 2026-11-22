"""Classical ballet knowledge: body measurements from 17 COCO keypoints, movement
recognition, technique feedback per body part, and motion across a sequence.

All geometry is 2-D, on the camera picture: angles are as the camera sees them
(foreshortening changes them), so results are guidance, not clinical measurements.

    keypoints.py     COCO keypoint indexes and point geometry
    measurements.py  joint angles and the facts the rules need (PoseMeasurements)
    movements.py     the movement catalogue with technique targets
    recognition.py   one scoring rule per movement
    feedback.py      corrections per body part
    evaluation.py    the three steps together (PoseEvaluation)
    motion.py        movement across a sequence of pictures
    dancer.py        which detected person to analyse
"""

from app.ballet import movements
from app.ballet.evaluation import PoseEvaluation, evaluate_pose
from app.ballet.recognition import MIN_CONFIDENCE


def vocabulary() -> dict:
    return movements.vocabulary(MIN_CONFIDENCE)


__all__ = ["PoseEvaluation", "evaluate_pose", "vocabulary"]
