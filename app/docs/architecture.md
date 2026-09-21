# Fleet Manager architecture (Phase 2)

`app/data` is the personal development data root and is never committed. Packaged Electron applications must use `app.getPath('userData')/fleet-manager-data` instead: an asar application path is not a writable data directory. The root should remain an injected/owned service dependency, not be hard-coded in repository code. `fleetSimulation/map` remains an Optimizer workspace and is populated only when the user explicitly imports or starts a saved task.

The Renderer has no Node.js integration. Its only privileged boundary is `window.fleetManager`, supplied by the context-isolated preload script. Main owns JSON validation, atomic writes, staging and process spawning.

`OptimizerRunner` holds a process-wide lock, streams stdout/stderr, writes a runtime task snapshot with selection and Node/Common SHA-256 hashes, requires exit code zero, rejects unchanged content or malformed result files, and validates Galaxy/Node where the Result exposes resolver identity. Existing Results do not embed Manager configuration hashes, so this cannot prove cryptographic result-to-input ownership; it reliably rejects stale, unchanged and obviously mismatched results without changing the Optimizer.

Phase 2 keeps management metadata separate from Optimizer JSON. Node `meta.json` owns stable Version IDs, display names and the default ID; Common uses the same pattern. Renaming changes only display metadata. Every Version/Common is a separate JSON file, and all writes use temporary-file replacement. Templates live under `data/templates`, are created only by explicit user action, and contain an ordinary validated Node JSON snapshot.

Node creation accepts either a selected Node Version or a managed template. It preserves the source configuration and rewrites only `galaxy` and `node` before schema validation and atomic creation. New Version/Common actions initialize from the corresponding default configuration; Copy actions initialize from the current selection. Neither searching nor applying a result creates management objects.

Best Found application is a Main-process transaction: stage the selected Manager Node/Common, invoke the existing `run_optimizer.bat <galaxy> <node> --c`, require exit code zero, parse and validate the modified workspace Node including identity, then atomically replace only the selected Manager Version. A non-zero copy exit or invalid workspace JSON exits before the Manager write. The Renderer enables this action only for a successful search result tied to the current four-part selection.
