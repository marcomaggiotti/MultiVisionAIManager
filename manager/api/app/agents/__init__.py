"""Agents built with LangChain: a chat model chooses which of the manager's abilities
(tools) to use, step by step, to reach a goal about a dancer's pictures.

    capabilities.py  what the manager can do with pictures: YOLO pose, ballet rules,
                     CLIP classification, VLM questions, the video library
    tools.py         those abilities as LangChain tools
    chat_models.py   the chat models: the local VLM module (a LangChain BaseChatModel),
                     and cloud models with native tool calling when configured
    executor.py      the agent loop: native tool calls, or the ReAct text protocol for
                     models without them (small local models)
"""
