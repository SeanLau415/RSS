# Requirements Summary

## Core Goal

Build a Telegram monitoring assistant that gives useful, human-readable results instead of debug fields.

## VPS Monitoring

- The bot should directly tell whether a VPS product is:
  - `In Stock`
  - `Out of Stock`
  - `Unknown`
- It should also show a short reason for the decision.
- It should not reply with meaningless values like `changed` or `content changed` as the main result.

## RSS Monitoring

- The bot should behave like an incremental reader.
- When opening an RSS source in the bot:
  - it should remember what has already been viewed,
  - only unread/new articles should be sent,
  - old articles must not be resent again and again.
- The article message should include:
  - source name
  - title
  - summary
  - published time
  - original link
  - link preview
  - `Source` button

## Interaction Style

- Main interaction should be list-and-tap, not command-line style CRUD.
- User should be able to:
  - open VPS list
  - open RSS list
  - tap an item
  - immediately see useful information

## Security

- Telegram secrets must stay in Cloudflare.
- VPS should not store Telegram bot token.
- This package does not include real secrets.
- Example and test placeholders may exist, but no production token/secret values are included.

## Package Notes

- This package is intended for GitHub/VPS update use.
- Cloudflare Worker code is included separately in:
  - `cloudflare-worker/index.js`
