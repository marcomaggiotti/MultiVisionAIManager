"""AI workflows: graphs of nodes (vision modules, VLM questions, agents, decisions,
questions to the user) built in the Admin page and run by LangGraph.

    graph.py      FlowGraph: nodes and conditional edges, and what prevents running it
    catalog.py    the node types: fields shown by the builder, validation, executor
    nodes.py      what each node type does when it runs
    runs.py       FlowRun and Step: a run's state as the page sees it
    engine.py     FlowRunner: compiles a graph into a LangGraph StateGraph (conditional
                  edges, interrupt() for questions, a checkpointer to resume) and runs it

The VLM tab's workflows are flows too (their "prompt" and "ask" nodes are aliases).
"""
