# 0043. Deployment-language list order

Accepted, Martin, 2026-10-24: “Configurable en-GB default (Recommended)”.

Deterministic ICU, default en-GB and configurable offline with std upgrade --list-locale, replaces decision 0008's code-point list order while retaining Unicode comparison-key equality, case settings, masking and ID ties. A shared query/index key and a condition SQL adapter equality-key seam keep one matching generated index rather than adding companion indexes and their write cost; mapped lists project their exposed codes/text before ordering. Provider/locale/version checks gate startup and doctor, and transactional dependent-index replacement records a new epoch that invalidates textual cursors, because accepting an old continuation under a different order can skip or repeat records (PostgreSQL 18 collation documentation).
