"""History of the modules' use: every YOLO, CLIP and VLM call made through the manager
(module tabs, Analysis, VLM tools, workflows, agents), with its picture, settings, answer
summary and time. The live studio's and Compare's per-frame calls are not recorded (their
sessions keep them).

    store.py     UsageHistory: SQLite records + a thumbnail of the input picture
    recorder.py  UsageRecorder: summarise and record a call; parse proxied requests
"""
