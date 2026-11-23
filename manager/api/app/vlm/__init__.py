"""Working with the VLM module from the manager: pictures of a video, saved prompts and
prompt comparison (workflows run as flows: ``app/flows``).

    client.py      VlmClient: ask the VLM module (prompt + pictures)
    inputs.py      the pictures a question is about: frames of a library video, or uploads
    templating.py  {{variables}} in prompts
    conditions.py  the tests on edges: contains, yes / no, greater than, regex...
    documents.py   DocumentStore: saved prompts, workflows and flows (SQLite, JSON bodies)
"""
