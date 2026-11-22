"""Real-time sessions: frames arrive one by one (camera, video or pictures) and each
gets the dancer's smoothed keypoints, the recognised movement and corrections.

    smoothing.py   KeypointSmoother: steadier keypoints between frames
    tracking.py    MovementTracker: a movement counts once it is held for a few frames
    corrections.py CorrectionLog: corrections that persist become comments
    session.py     LiveSession: the three together, one call per frame
    frames.py      send a frame to the YOLO module and update the session
"""

from app.live.frames import process_frame
from app.live.session import LiveSession, LiveSettings

__all__ = ["LiveSession", "LiveSettings", "process_frame"]
