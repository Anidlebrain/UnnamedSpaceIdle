# Phase 1 architecture

`app/data` is the personal development data root and is never committed. Packaged Electron applications must use `app.getPath('userData')/fleet-manager-data` instead: an asar application path is not a writable data directory. The root should remain an injected/owned service dependency, not be hard-coded in repository code. `fleetSimulation/map` remains an Optimizer workspace and is populated only when the user explicitly imports or starts a saved task.

The Renderer has no Node.js integration. Its only privileged boundary is `window.fleetManager`, supplied by the context-isolated preload script. Main owns JSON validation, atomic writes, staging and process spawning.

`OptimizerRunner` holds a process-wide lock, streams stdout/stderr, writes a runtime task snapshot with selection and Node/Common SHA-256 hashes, requires exit code zero, rejects unchanged content or malformed result files, and validates Galaxy/Node where the Result exposes resolver identity. Existing Results do not embed Manager configuration hashes, so this cannot prove cryptographic result-to-input ownership; it reliably rejects stale, unchanged and obviously mismatched results without changing the Optimizer.
