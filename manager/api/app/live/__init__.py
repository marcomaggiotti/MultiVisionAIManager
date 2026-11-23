"""Real-time sessions: frames arrive one by one (camera, video or pictures) and each
gets the dancer's smoothed keypoints, the recognised movement and corrections.

    smoothing.py   KeypointSmoother: steadier keypoints between frames
    tracking.py    MovementTracker: a movement counts once it is held for a few frames
    corrections.py CorrectionLog: corrections that persist become comments
    session.py     LiveSession: the three together, one call per frame
    adjustments.py keypoints corrected by hand, applied when a video is analysed again
    comparison.py  ComparisonSession: a reference video and a student, side by side
    frames.py      send frames to the YOLO module and update the sessions
"""

from app.live.comparison import ComparisonSession, ComparisonSettings
from app.live.frames import process_frame, process_pair
from app.live.session import LiveSession, LiveSettings

__all__ = ["ComparisonSession", "ComparisonSettings", "LiveSession", "LiveSettings", "process_frame", "process_pair"]
