# STD glossary

- **Form rule:** a conditional browser field constraint owned by a class and inherited by its subclasses. Its property is required, read-only, hidden or a choice restriction (Contracts 5.10). _Avoid:_ UI policy, form validation.
- **Proposed record:** the candidate record image for an operation, including stored values, supplied values and applicable derive results (Contracts 4.10). _Avoid:_ draft record, simulated record.
- **Form-state verdict:** the caller-masked field states and derived values for one versioned form proposal (Contracts 5.8, 6.3). _Avoid:_ save permission, validation result.

- **Free text:** a caller-authored textual value whose language is not controlled by the API, explicitly classified by its field's text policy (Contracts 5.5). _Avoid:_ normalized prose.
- **Coded value:** a language-independent status, action or category value with a separately presented label (Contracts 5.5, 11.2). _Avoid:_ translated code.
- **List order:** the deployment's deterministic ICU ordering policy for textual list keys, identified by provider, locale, ICU version and an installation epoch (Contracts 3.5). _Avoid:_ database default order.
