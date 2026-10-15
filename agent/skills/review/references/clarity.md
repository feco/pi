# Clarity and maintainability review

Flag an issue only when it creates a concrete cost in this change: a misreading that leads to wrong use, or extra work for the next change.

- Misleading names, comments, or signatures: the name says one thing and the code does another.
- Unnecessary complexity or speculative generality.
- Duplicated business rules that can diverge.
- Feature logic in the wrong owning layer.
- Broken module boundaries, circular dependencies, or hidden global state.
- Dead code or obsolete compatibility paths introduced or stranded by the change.
- Refactors that move complexity without reducing it.
- Control flow a reader must trace several times to follow: deep nesting, flag arguments, or conditions that grow a new branch per case.

Prefer the smallest remedy that removes the cost. Do not demand unrelated cleanup or a preferred style when local conventions permit the implementation.
