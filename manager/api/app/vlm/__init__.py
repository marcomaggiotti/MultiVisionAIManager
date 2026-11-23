"""Working with the VLM module from the manager: pictures of a video, saved prompts,
prompt comparison, and decision workflows.

    client.py      VlmClient: ask the VLM module (prompt + pictures)
    inputs.py      the pictures a question is about: frames of a library video, or uploads
    templating.py  {{variables}} in prompts
    conditions.py  the tests on edges: contains, yes / no, greater than, regex...
    documents.py   DocumentStore: saved prompts and workflows (SQLite, JSON bodies)
    workflow.py    the workflow graph: nodes, edges, validation
    runner.py      WorkflowRun / WorkflowRunner: run a graph, pause for the user's answers
"""
