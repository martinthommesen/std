# 0042. Preserve classified free text

Accepted, Martin, 2026-10-24: “Preserve free text exactly (Recommended)”.

Because global normalization destroys caller-authored prose, explicit textPolicy/nonBlank settings separate scalar preservation from validation, retaining identifier conversion and required non-blank rules while superseding the text-conversion policy in decision 0003 and Contracts 5.5. Core v6/helpdesk v4 change subsequent input only; earlier definitions, rows, images and queued events remain recorded facts, and lost original text is unrecoverable. Shared codecs and full-type literal conversion carry the classification through every implemented entry path instead of introducing a TMF-specific write policy.
