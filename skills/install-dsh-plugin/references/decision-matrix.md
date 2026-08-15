# Guided install decision matrix

Use the first row whose evidence is fully satisfied.

| Evidence | Route | Permission boundary |
| --- | --- | --- |
| Registry verifies an exact npm version, and the downloaded package contains the declared patch and runtime entries | Install `package@version` with `--ignore-scripts` | No lifecycle script may run |
| Exact GitHub commit already contains every runtime entry and the declared patch | Install `github:owner/repo#commit` with `--ignore-scripts` | Ignore `prepare`; committed output makes it unnecessary |
| Exact commit is valid but runtime output is missing | Clone exact commit, install dependencies with scripts disabled, inspect, request approval for the named build command, inspect again, pack with scripts disabled, install the local tarball | Build/prepack code requires explicit approval |
| An immutable artifact has a Registry-bound digest and its unpacked identity passes inspection | Install the local verified artifact with `--ignore-scripts` | Verify the digest before unpacking |

Do not use a mutable Release URL or an artifact without a Registry-bound digest. Prefer rebuilding the exact commit; stop if a reproducible build or safe package cannot be produced.

Treat `preinstall`, `install`, `postinstall`, `prepare`, `prepack`, and similar hooks as code execution. A committed runtime artifact may make `prepare` unnecessary; use `--ignore-scripts`. If a hook is functionally required, inspect it and request approval for that exact hook.

After installation, apply author-required configuration only to the plugin's documented namespace. Never copy credentials from another provider or echo secret values. Report UI location and startup behavior from the exact commit's documentation.
