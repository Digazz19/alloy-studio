# Alloy Studio

A Visual Studio Code extension providing comprehensive IDE support for the [Alloy](https://alloytools.org/) formal specification language, built on standard protocols (LSP and DAP).

Developed as part of a Master's dissertation in Informatics Engineering at the University of Minho, supervised by Professor Nuno Filipe Moreira Macedo.

---

## Features

### Language Support (LSP)
- **Real-time diagnostics** — syntax and semantic errors highlighted as you type
- **Hover information** — details about signatures, fields, and predicates on hover
- **Go to Definition** — navigate to the definition of any symbol
- **Document Symbols / Outline** — view the structure of your model in the outline panel
- **Syntax highlighting** — keywords, temporal operators, and operators are color-coded

### Instance Exploration
- **▶ Run** — execute a specific `run` or `check` command via a Quick Pick menu
- **▶▶ Run All** — execute all commands in the file and view a summary of results (SAT/UNSAT) with the first instance or counterexample
- **Interactive graph** — instances are rendered as interactive D3.js force-directed graphs with colored nodes per signature and labeled relation edges
- **Instance navigation** — navigate between instances using Previous, Next, New Trace, New Init, New Config, and New Fork
- **Temporal trace navigation** — for Alloy 6 temporal models, navigate between states of a trace

### Debugger Adapter Protocol (DAP)
- **Run and Debug panel** — explore instances through VS Code's native debug interface
- **Call Stack** — trace states displayed as stack frames
- **Variables** — atoms and relations of the current state shown in the Variables panel
- **Watch** — evaluate arbitrary Alloy expressions against the current instance
- **Hover evaluation** — hover over any expression in the editor to see its value
- **Debug Console (REPL)** — evaluate expressions interactively
- **Bidirectional synchronization** — the instance graph and the DAP panel are always in sync

### Testing
- **Testing panel** — `run` and `check` commands appear as tests in VS Code's native Testing panel
- **Automatic discovery** — tests are discovered automatically when a `.als` file is opened
- **`expect` support** — `run ... expect 0` passes if UNSAT; `run ... expect 1` passes if SAT
- **Test output** — first instance or counterexample shown in the test output

### Configuration
- **Alloy: Configure Analysis Options** (`Ctrl+Shift+P`) — configure the SAT solver, symmetry breaking, Skolem depth, and other options

---

## Requirements

- **Java 17 or later**
- **Node.js 18 or later**
- **Maven** (to build the analysis server)
- **alloy.jar** — Alloy 6.2.0 / 6.3.0 ([download](https://github.com/AlloyTools/org.alloytools.alloy/releases))

---

## Getting Started (Development Mode)

### 1. Clone the repository

```bash
git clone https://github.com/Digazz19/alloy-studio.git
cd alloy-studio
```

### 2. Get the Alloy JAR

**Option A — Download the latest release (6.2.0):**

Download `org.alloytools.alloy.dist.jar` from the [Alloy releases page](https://github.com/AlloyTools/org.alloytools.alloy/releases) and save it to a convenient location.

**Option B — Build from source (6.3.0-SNAPSHOT):**

```bash
git clone --recursive https://github.com/AlloyTools/org.alloytools.alloy.git
cd org.alloytools.alloy
./gradlew build
```

### 3. Build the analysis server

```bash
cd alloy-server

# Install the Alloy JAR into the local Maven repository
mvn install:install-file \
  -Dfile=/path/to/alloy.jar \
  -DgroupId=org.alloytools \
  -DartifactId=alloy \
  -Dversion=6.2.0 or 6.3.0 \
  -Dpackaging=jar

# Build the server
mvn package -q
```

This produces `alloy-server/target/alloy-server-1.0-SNAPSHOT-jar-with-dependencies.jar`.

### 4. Install extension dependencies

```bash
cd alloy-studio
npm install
npm run compile
```

### 5. Configure the extension

Create or edit the `.vscode/settings.json` file in your Alloy models folder:

```json
{
  "alloy.jarPath": "/path/to/alloy.jar",
  "alloy.serverJarPath": "/path/to/alloy-server-1.0-SNAPSHOT-jar-with-dependencies.jar"
}
```

Replace `/path/to/alloy.jar` with the path to the Alloy JAR you downloaded or built in step 2, and `/path/to/alloy-studio` with the path where you cloned this repository.

> **Note:** A template is available at `.vscode/settings.example.json` in the extension folder.

### 6. Launch the extension

Open the `alloy-studio` folder in VS Code, press **F5** to open an Extension Development Host window. Open a `.als` file to start using the extension.

---

## Usage

### Running a command

Open a `.als` file and click the **▶** button in the editor title bar to run a specific command. A Quick Pick menu will appear with all `run` and `check` commands in the file.

### Running all commands

Click the **▶▶** button in the editor title bar to run all commands and view a summary of results.

### Debugging an instance

Press **F5** or open the Run and Debug panel (`Ctrl+Shift+D`) to launch a debug session. Choose the command to execute from the Quick Pick menu.

During a debug session, use the buttons in the editor title bar:

| Button | Operation | Description |
|---|---|---|
| ◀ Previous | Previous instance | Returns to the previous instance using the session history |
| Next ▶ | Next instance | Requests the next satisfiable instance from the solver |
| New Trace | New trace | Generates a new trace with the same configuration |
| New Init | New initial state | Generates a new trace with a different initial state |
| New Config | New configuration | Generates a new trace with a different static configuration |
| New Fork | New fork | Generates a new trace diverging from the current state |
| ⏹ Stop | Stop debug session | Terminates the session and releases server resources |

### Configuring analysis options

Press `Ctrl+Shift+P` and search for **Alloy: Configure Analysis Options** to set the SAT solver, symmetry breaking level, and other parameters. These settings are saved globally and used by all execution modes.

Available solvers: `sat4j`, `sat4j.light`, `sat4j.pmax`, `minisat`, `minisat.prover`, `glucose`, `lingeling.parallel`

### Testing

Open the Testing panel (beaker icon in the sidebar) to view all `run` and `check` commands as tests. Click **▶ Run All Tests** to execute them all.

The `expect` annotation controls the expected outcome:
- `run somePred for 3 expect 1` — passes if SAT (default behaviour)
- `run somePred for 3 expect 0` — passes if UNSAT
- `check someAssertion for 3` — passes if UNSAT (property verified)
- `check someAssertion for 3 expect 1` — passes if SAT (counterexample expected)

---

## Project Structure

```
alloy-studio/
├── src/
│   ├── extension.ts           # Extension entry point
│   ├── alloyDebugAdapter.ts   # DAP implementation
│   ├── alloyState.ts          # Shared state (bidirectional sync)
│   └── alloyTestProvider.ts   # VS Code Testing API integration
├── syntaxes/
│   └── alloy.tmLanguage.json  # Syntax highlighting grammar
├── package.json               # Extension manifest
└── alloy-server/              # Companion Java analysis server
    └── src/main/java/com/alloy/server/
        └── AlloyServer.java
```

---

## License

This project is licensed under the CC BY 4.0 License.