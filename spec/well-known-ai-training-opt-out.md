# `/.well-known/ai-training-opt-out`

_Status: proposal, version 1. Feedback welcome via GitHub issues._

## Summary

A small JSON document, served at a fixed URL, in which an online service states whether it trains AI
models on its users' content and where users can opt out. Browsers, password managers and privacy tools
can read it to send people straight to the right setting, the same way
[`/.well-known/change-password`](https://w3c.github.io/webappsec-change-password-url/) sends them to the
change-password page.

## Motivation

Many services now use what their users post, upload or type to train AI models, often by default and
with the opt-out buried in a settings page that moves with every redesign. People who want to opt out
have to find each setting by hand, and tools that help them have to maintain per-site knowledge that
breaks constantly. A predictable, machine-readable location costs a service a few lines of JSON and
turns a scavenger hunt into one click.

## Location

The document is served at `https://<host>/.well-known/ai-training-opt-out`, using the well-known URI
mechanism of [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615). It must be served over HTTPS with
`Content-Type: application/json`. A service that operates several hosts serves the document on each
host where users sign in.

## Format

```json
{
  "version": 1,
  "name": "Example Service",
  "trains_on_user_content": "yes",
  "default": "opted_in",
  "opt_out_url": "https://example.com/settings/privacy/ai",
  "policy_url": "https://example.com/privacy#ai-training",
  "data_types": ["posts", "messages"],
  "regions": ["ALL"],
  "last_updated": "2026-09-01",
  "contact": "privacy@example.com"
}
```

| Field                    | Required                                | Meaning                                                                             |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `version`                | yes                                     | Format version. Always `1` for this specification.                                  |
| `trains_on_user_content` | yes                                     | `yes`, `no` or `conditional` (only some products, plans or regions).                |
| `opt_out_url`            | unless `trains_on_user_content` is `no` | HTTPS URL of the page where a signed-in user turns training off.                    |
| `last_updated`           | yes                                     | Date the statement was last reviewed, `YYYY-MM-DD`.                                 |
| `name`                   | no                                      | Human-readable service name.                                                        |
| `default`                | no                                      | `opted_in` (training on until the user opts out), `opted_out` or `no_choice`.       |
| `policy_url`             | no                                      | HTTPS URL of the policy text describing the training.                               |
| `data_types`             | no                                      | Kinds of content used, e.g. `posts`, `messages`, `files`, `voice`.                  |
| `regions`                | no                                      | Where the opt-out is offered: `ALL` or region codes (`EU`, `UK`, `US`, `US-CA`, …). |
| `contact`                | no                                      | Email address or HTTPS URL for privacy requests.                                    |

The full machine-readable definition is [`ai-training-opt-out.schema.json`](ai-training-opt-out.schema.json);
[`examples/`](examples/) has sample documents.

## Processing rules for consumers

1. Fetch the document only in response to a user action or at low frequency, and never send
   credentials or other user data with the request.
2. Ignore documents larger than 64 KB, documents that are not valid JSON, and documents whose `version`
   is not supported.
3. Ignore unknown fields.
4. Only open `opt_out_url` if it uses HTTPS and is on the same registrable domain as the host that
   served the document (or one of its subdomains).
5. Treat the document as the service's own claim. It is not a substitute for independent review of
   the service's policies.

## Security and privacy considerations

The document is public and contains no user data. Because `opt_out_url` is shown to users as a trusted
link, consumers must apply rule 4 so that a compromised or malicious document cannot send users to a
look-alike site. Consumers should not fetch the document in the background for every site visited,
since that reveals browsing activity to the sites' servers.

## Relationship to other mechanisms

- `robots.txt` user-agent rules, [TDMRep](https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240202/)
  and `ai.txt` let _website owners_ tell crawlers not to collect their content. This document is the
  other direction: a _service_ telling _its users_ how their own content is used and how to stop it.
- It complements, and does not replace, legal rights such as the GDPR right to object (Art. 21).

## Registration template (RFC 8615)

- URI suffix: `ai-training-opt-out`
- Change controller: NoTrain contributors
- Specification document: this document
- Status: provisional
