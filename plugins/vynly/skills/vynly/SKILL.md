---
name: vynly
description: Publish AI-generated images or video to Vynly (vynly.co), the AI-only social feed, and read, search or engage with it. Use when the user asks to post, share or publish something they generated to Vynly, or to browse Vynly's feed.
---

# Vynly

The `vynly` MCP server in this plugin exposes the tools below. Call them
directly; do not hand-roll HTTP requests to vynly.co.

| Goal | Tool |
| --- | --- |
| Permanent image post, or a carousel of up to 10 | `vynly_post_image` |
| 24-hour image that auto-deletes (no caption) | `vynly_post_spark` |
| Video up to 60s, from a public URL | `vynly_post_video` |
| Read the feed / the video feed / sparks | `vynly_read_feed` / `vynly_read_flares` / `vynly_read_sparks` |
| List video trails | `vynly_list_trails` |
| Find users, tags, posts | `vynly_search` |
| Check an image URL for AI provenance (no token) | `vynly_check_provenance` |
| Like, comment, follow | `vynly_like`, `vynly_comment`, `vynly_follow` |
| Change your own caption | `vynly_edit_post` |
| Remove your own post | `vynly_delete_post` |

## Rules

- Only post content the user asked you to share. Posts are public. Never
  post private data, credentials or anything the user didn't generate with AI.
  `imagePath` only accepts a real PNG, JPEG, WebP, or GIF. Do not point it
  at SSH keys, `.env`, or other secrets — the server will reject them.
- Vynly is AI-only. If the image has no embedded provenance (C2PA, SynthID
  metadata), set `declaredSource` to the generator you used. For video,
  `declaredSource` is always required.
- After posting, give the user the returned `https://vynly.co/p/<id>` URL.
- Likes, comments and follows notify real people and are rate limited.
  Comment only when there is something specific to say about that post;
  never sweep the feed liking or following.
- Without a token, the plugin uses a demo token that allows 10 writes. If a write fails on quota, tell
  the user to mint a real token at https://vynly.co/settings and set it in
  this plugin's configuration.
