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

- **Java 17** (required to build the Alloy JAR from source; Java 21 also works for running)
- **Node.js 18 or later**
- **Maven** (to build the analysis server)
- **alloy.jar** — Alloy 6.2.0 or 6.3.0-SNAPSHOT (see step 2)

---

## Getting Started (Development Mode)

### 1. Clone the repository

```bash
git clone https://github.com/Digazz19/alloy-studio.git
cd alloy-studio
```

### 2. Get the Alloy JAR

**Option A — Download the latest release (6.2.0):**

Download `org.alloytools.alloy.dist.jar` from the [Alloy releases page](https://github.com/AlloyTools/org.alloytools.alloy/releases) and save it to a convenient location, for example `~/alloy/alloy.jar`.

**Option B — Build from source (6.3.0-SNAPSHOT):**

> **Note:** Building from source requires **Java 17**. Java 21 is not supported by the Gradle version used.

```bash
# Install Java 17 if needed
sudo apt install openjdk-17-jdk -y
sudo update-alternatives --config java  # select Java 17

git clone --recursive https://github.com/AlloyTools/org.alloytools.alloy.git
cd org.alloytools.alloy
./gradlew build
# JAR will be at: org.alloytools.alloy.dist/target/org.alloytools.alloy.dist.jar
```

Save the JAR to a convenient location, for example `~/alloy/alloy.jar`.

### 3. Build the analysis server

Run the following from the **root of the repository** (not inside `alloy-server/`):

```bash
# Install the Alloy JAR into the local Maven repository
mvn install:install-file \
  -Dfile=/path/to/alloy.jar \
  -DgroupId=org.alloytools \
  -DartifactId=alloy \
  -Dversion=6.3.0 \
  -Dpackaging=jar

# Build the server
cd alloy-server
mvn package -q
```

This produces `alloy-server/target/alloy-server-1.0-SNAPSHOT-jar-with-dependencies.jar`.

### 4. Install extension dependencies

From the **root of the repository**:

```bash
npm install
npm run compile
```

### 5. Create a models folder and configure settings

Create a folder where you will keep your `.als` files, for example `~/alloy-models`. Inside it, create a `.vscode/settings.json` file:

```bash
mkdir -p ~/alloy-models/.vscode
```

Create `~/alloy-models/.vscode/settings.json` with the following content, replacing the paths with your own:

```json
{
    "alloy.jarPath": "/path/to/alloy.jar",
    "alloy.serverJarPath": "/path/to/alloy-studio/alloy-server/target/alloy-server-1.0-SNAPSHOT-jar-with-dependencies.jar",
    "[alloy]": {
        "editor.codeLens": false,
        "editor.semanticHighlighting.enabled": false
    }
}
```

> A template is available at `.vscode/settings.example.json` in the extension folder.

### 6. Launch the extension

1. Open the `alloy-studio` folder in VS Code
2. Press **F5** — an **Extension Development Host** window opens
3. In the Extension Development Host window, go to `File → Open Folder` and select your models folder (e.g. `~/alloy-models`)
4. Create or open a `.als` file — the extension activates automatically

You should see the message **"Alloy Analysis Server initialized."** in the bottom right corner confirming the server started successfully.

---

## Usage

### Running a command

Open a `.als` file and click the **▶** button in the editor title bar to run a specific command. A Quick Pick menu will appear with all `run` and `check` commands in the file.

### Running all commands

Click the **▶▶** button in the editor title bar to run all commands and view a summary of results (SAT/UNSAT) with the first instance or counterexample for each command.

### Debugging an instance

Press **F5** or open the Run and Debug panel (`Ctrl+Shift+D`) to launch a debug session. Choose the command to execute from the Quick Pick menu.

During a debug session, the editor title bar shows the following buttons:

| Button | Operation | Description |
|---|---|---|
| ◀ Previous | Previous instance | Returns to the previous instance using the session history |
| Next ▶ | Next instance | Requests the next satisfiable instance from the solver |
| New Trace | New trace | Generates a new trace with the same configuration |
| New Init | New initial state | Generates a new trace with a different initial state |
| New Config | New configuration | Generates a new trace with a different static configuration |
| New Fork | New fork | Generates a new trace diverging from the current state |
| ⏹ Stop | Stop debug session | Terminates the session and releases server resources |

The Run and Debug panel shows:
- **Call Stack** — states of the trace (click to navigate between states)
- **Variables → Atoms** — current state's signature atoms
- **Variables → Relations** — current state's field relations
- **Watch** — evaluate Alloy expressions (e.g. `#Borrows`, `Person.~role`)
- **Debug Console** — evaluate expressions interactively

### Configuring analysis options

Press `Ctrl+Shift+P` and search for **Alloy: Configure Analysis Options** to set:
- SAT solver (`sat4j`, `sat4j.light`, `minisat`, `glucose`, etc.)
- Symmetry breaking level (default: 20)
- Skolem depth (default: 0)
- No overflow (default: false)
- Recursion unrolls (default: -1)

These settings are saved globally and used by all execution modes (Run, Run All, Debug, Testing).

### Testing

Open the Testing panel (🧪 beaker icon in the sidebar). All `run` and `check` commands in open `.als` files appear as tests automatically.

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

## DAP Mapping

| DAP Concept | Alloy Concept |
|---|---|
| Debug Session | Analysis session (`execute`) |
| Thread | Alloy analysis (single thread) |
| Stack Frame | State of the temporal trace |
| Scope "Atoms" | Signatures and their atoms |
| Scope "Relations" | Fields and relations between atoms |
| Step Over | `next()` — next instance |
| Continue | `fork(stateIndex)` — New Fork |
| Step Back | `previous()` — previous instance (via history) |
| Restart | `next()` — New Trace |
| Terminated | No more instances available |

---

## License

This project is licensed under the CC BY 4.0 License.