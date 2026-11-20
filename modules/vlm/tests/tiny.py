"""A tiny, randomly initialised SmolVLM (Idefics3) built offline, for tests."""

from __future__ import annotations

TEMPLATE = (
    "{% for m in messages %}{{ m['role'] }}:"
    "{% for c in m['content'] %}{% if c['type'] == 'image' %}<image>{% else %} {{ c['text'] }}{% endif %}{% endfor %}"
    "<end_of_utterance>\n{% endfor %}{% if add_generation_prompt %}assistant:{% endif %}"
)


def tiny_smolvlm():
    import torch
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import (
        Idefics3Config,
        Idefics3ForConditionalGeneration,
        Idefics3ImageProcessor,
        Idefics3Processor,
        PreTrainedTokenizerFast,
    )

    words = ["<unk>", "<pad>", "<s>", "</s>", "user:", "assistant:", "system:", "a", "dancer", "in",
             "arabesque", "plié", "describe", "the", "pose", "what", "step", "is", "this", "?", ".",
             "picture", "1:", "2:", "user", "assistant", "system", ":"]  # fmt: skip
    vocab = {w: i for i, w in enumerate(words)}
    tok = Tokenizer(models.WordLevel(vocab, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=tok, unk_token="<unk>", pad_token="<pad>", bos_token="<s>", eos_token="</s>"
    )
    tokenizer.add_special_tokens(
        {"additional_special_tokens": ["<fake_token_around_image>", "<image>", "<global-img>", "<end_of_utterance>"]}
    )
    image_processor = Idefics3ImageProcessor(
        size={"longest_edge": 64}, max_image_size={"longest_edge": 32}, do_image_splitting=True
    )
    processor = Idefics3Processor(
        image_processor=image_processor, tokenizer=tokenizer, image_seq_len=4, chat_template=TEMPLATE
    )
    cfg = Idefics3Config(
        vision_config=dict(hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2,
                           image_size=32, patch_size=8),
        text_config=dict(hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2,
                         num_key_value_heads=2, vocab_size=len(tokenizer), max_position_embeddings=512,
                         pad_token_id=tokenizer.pad_token_id),
        scale_factor=2,
        image_token_id=tokenizer.convert_tokens_to_ids("<image>"),
        pad_token_id=tokenizer.pad_token_id,
    )  # fmt: skip
    cfg._attn_implementation = "eager"
    torch.manual_seed(0)
    model = Idefics3ForConditionalGeneration(cfg).eval()
    model.generation_config.pad_token_id = tokenizer.pad_token_id
    model.generation_config.eos_token_id = tokenizer.eos_token_id
    return model, processor
