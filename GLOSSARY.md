# STD glossary

- **Subscription:** a configuration record selecting committed changes for delivery as one identity (Contracts 4.6).
- **Hub:** a listener registration held by a subscription and owned by its identity (Contracts 12.2).
- **Form rule:** a conditional browser field constraint owned by a class and inherited by its subclasses. Its property is required, read-only, hidden or a choice restriction (Contracts 5.10). _Avoid:_ UI policy, form validation.
- **Proposed record:** the candidate record image for an operation, including stored values, supplied values and applicable derive results (Contracts 4.10). _Avoid:_ draft record, simulated record.
- **Form-state verdict:** the caller-masked field states and derived values for one versioned form proposal (Contracts 5.8, 6.3). _Avoid:_ save permission, validation result.
