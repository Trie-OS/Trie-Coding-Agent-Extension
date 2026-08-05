# Extension coding smoke

`npm run bench:coding-smoke` bundles the real VS Code extension agent loop and
runs deterministic scripted-model tasks in temporary workspaces.

It currently checks:

- read → line edit → automatic typecheck → complete
- create file → automatic typecheck → complete

This is a **harness contract smoke suite**, not a model-quality score. A real
`forge-bench` runner must execute the same fixed tasks against named models and
report edit accuracy, verification pass rate, generations, and elapsed time.

