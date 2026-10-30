package com.alloy.server;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.alloy4.Err;
import edu.mit.csail.sdg.alloy4.ErrorWarning;
import edu.mit.csail.sdg.alloy4.Pair;
import edu.mit.csail.sdg.alloy4.Pos;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.ast.Module;
import edu.mit.csail.sdg.parser.CompUtil;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;
import edu.mit.csail.sdg.ast.Sig;
import edu.mit.csail.sdg.ast.Sig.PrimSig;
import edu.mit.csail.sdg.ast.Sig.SubsetSig;
import edu.mit.csail.sdg.ast.Sig.Field;

import java.io.*;
import java.net.*;
import java.util.*;

public class AlloyServer {

    private static final int DEFAULT_PORT = 5050;
    private static final Gson gson = new Gson();

    // Sessões ativas
    private static final Map<String, A4Solution> sessions = new HashMap<>();
    private static final Map<String, List<Command>> sessionCommands = new HashMap<>();
    private static final Map<String, Module> sessionModules = new HashMap<>();
    private static final Map<String, Integer> sessionCommandIndex = new HashMap<>();
    private static final Map<String, List<A4Solution>> sessionHistory = new HashMap<>();

    public static void main(String[] args) throws IOException {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : DEFAULT_PORT;
        ServerSocket serverSocket = new ServerSocket(port);
        System.out.println("Alloy Analysis Server running on port " + port);

        while (true) {
            Socket client = serverSocket.accept();
            new Thread(() -> handleClient(client)).start();
        }
    }

    private static void handleClient(Socket client) {
        try (
            BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream()));
            PrintWriter out = new PrintWriter(client.getOutputStream(), true)
        ) {
            String line;
            while ((line = in.readLine()) != null) {
                String response = handleRequest(line);
                out.println(response);
            }
        } catch (IOException e) {
            System.err.println("Client error: " + e.getMessage());
        }
    }

    private static String handleRequest(String requestJson) {
        try {
            JsonObject req = gson.fromJson(requestJson, JsonObject.class);
            String action = req.get("action").getAsString();
            System.out.println("Request: " + requestJson);

            switch (action) {
                case "execute":   return handleExecute(req);
                case "next":      return handleNext(req);
                case "previous":  return handlePrevious(req);
                case "newConfig": return handleNewConfig(req);
                case "newTrace":  return handleNewTrace(req);
                case "newInit":   return handleNewInit(req);
                case "newFork":   return handleNewFork(req);
                case "close":     return handleClose(req);
                case "evaluate":  return handleEvaluate(req);
                case "metamodel": return handleMetamodel(req);
                default:          return error("Unknown action: " + action);
            }
        } catch (Exception e) {
            e.printStackTrace();
            return error(e.getMessage());
        }
    }

    private static String handleExecute(JsonObject req) {
        try {
            String filePath = req.get("file").getAsString();
            int commandIndex = req.get("commandIndex").getAsInt();
            String sessionId = UUID.randomUUID().toString();

            // Reporter que recolhe o que o Analyzer escreve no message log, e os warnings
            SessionReporter reporter = new SessionReporter();
            // Implicit 'this' (Analyzer: Options > Enable 'implicit this' name resolution)
            int resolutionMode = optBoolean(req, "implicitThis", false) ? 2 : 1;
            Module world = CompUtil.parseEverything_fromFile(reporter, null, filePath, resolutionMode);
            List<Command> commands = world.getAllCommands();

            if (commandIndex >= commands.size()) {
                return error("Command index out of range");
            }

            Command command = commands.get(commandIndex);

            // Allow warnings: como no Analyzer, se estiver desligado e houver warnings,
            // o comando não é executado
            if (reporter.warnings.size() > 0 && !optBoolean(req, "allowWarnings", false)) {
                JsonObject response = new JsonObject();
                response.addProperty("error", reporter.warnings.size()
                    + " warning(s) found; the command was not executed. "
                    + "Fix the warnings, or enable the alloy.allowWarnings setting to execute despite them.");
                response.add("warnings", reporter.warnings);
                response.add("log", reporter.logJson());
                return gson.toJson(response);
            }

            A4Options options = new A4Options();

            // Solver
            if (req.has("solver") && !req.get("solver").getAsString().isEmpty()) {
                String solverName = req.get("solver").getAsString();
                try {
                    options.solver = kodkod.engine.satlab.SATFactory.get(solverName);
                } catch (Exception e) {
                    options.solver = kodkod.engine.satlab.SATFactory.DEFAULT;
                }
            } else {
                options.solver = kodkod.engine.satlab.SATFactory.DEFAULT;
            }

            if (req.has("symmetry") && !req.get("symmetry").isJsonNull()) {
                options.symmetry = req.get("symmetry").getAsInt();
            }

            if (req.has("skolemDepth") && !req.get("skolemDepth").isJsonNull()) {
                options.skolemDepth = req.get("skolemDepth").getAsInt();
            }

            if (req.has("noOverflow") && !req.get("noOverflow").isJsonNull()) {
                options.noOverflow = req.get("noOverflow").getAsBoolean();
            }

            if (req.has("unrolls") && !req.get("unrolls").isJsonNull()) {
                options.unrolls = req.get("unrolls").getAsInt();
            }

            if (req.has("decomposeMode") && !req.get("decomposeMode").isJsonNull()) {
                options.decompose_mode = req.get("decomposeMode").getAsInt();
            }

            // Restantes opções do menu Options do Analyzer. O valor por omissão de
            // inferPartialInstance na API é true, mas no Analyzer é false: usar o do Analyzer.
            options.inferPartialInstance = optBoolean(req, "inferPartialInstance", false);
            options.recordKodkod = optBoolean(req, "recordKodkod", false);
            if (req.has("coreMinimization") && !req.get("coreMinimization").isJsonNull()) {
                options.coreMinimization = req.get("coreMinimization").getAsInt();
            }
            if (req.has("coreGranularity") && !req.get("coreGranularity").isJsonNull()) {
                options.coreGranularity = req.get("coreGranularity").getAsInt();
            }

            reporter.log.add("Executing \"" + command + "\"");
            A4Solution solution = TranslateAlloyToKodkod.execute_command(
                reporter, world.getAllReachableSigs(), command, options
            );

            sessions.put(sessionId, solution);
            sessionCommands.put(sessionId, commands);
            sessionModules.put(sessionId, world);
            sessionCommandIndex.put(sessionId, commandIndex);
            sessionHistory.put(sessionId, new ArrayList<>(List.of(solution)));

            JsonObject response = buildResponseObject(sessionId, solution, command);
            response.add("log", reporter.logJson());
            response.add("warnings", reporter.warnings);

            // Unsat core: só disponível com um solver que produz provas (ex.: minisat.prover)
            if (!solution.satisfiable()) {
                response.addProperty("coreSupported", options.solver.prover());
                Pair<Set<Pos>, Set<Pos>> core = solution.highLevelCore();
                if (!core.a.isEmpty() || !core.b.isEmpty()) {
                    JsonObject coreJson = new JsonObject();
                    coreJson.add("core", posArray(core.a));        // fórmulas do core
                    coreJson.add("subCore", posArray(core.b));     // corpos das funções envolvidas
                    response.add("unsatCore", coreJson);
                }
            }

            // Record the Kodkod input/output: o problema Kodkod em Java, como o Analyzer o grava
            if (options.recordKodkod) {
                response.addProperty("kodkod", solution.debugExtractKInput());
            }

            return gson.toJson(response);

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String handleNext(JsonObject req) {
        try {
            String sessionId = req.get("sessionId").getAsString();
            A4Solution current = sessions.get(sessionId);
            if (current == null) return error("Session not found: " + sessionId);

            A4Solution next = current.next();

            if (!next.satisfiable()) {
                JsonObject response = new JsonObject();
                response.addProperty("sessionId", sessionId);
                response.addProperty("satisfiable", false);
                response.addProperty("hasNext", false);
                response.addProperty("noMoreInstances", true);
                return gson.toJson(response);
            }

            sessions.put(sessionId, next);
            sessionHistory.get(sessionId).add(next);

            int cmdIndex = sessionCommandIndex.get(sessionId);
            List<Command> commands = sessionCommands.get(sessionId);
            return buildResponse(sessionId, next, commands.get(cmdIndex));

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String handlePrevious(JsonObject req) {
        try {
            String sessionId = req.get("sessionId").getAsString();
            List<A4Solution> history = sessionHistory.get(sessionId);

            if (history == null || history.size() < 2) {
                JsonObject response = new JsonObject();
                response.addProperty("sessionId", sessionId);
                response.addProperty("noPreviousInstance", true);
                return gson.toJson(response);
            }

            // Remover a instância atual e voltar à anterior
            history.remove(history.size() - 1);
            A4Solution previous = history.get(history.size() - 1);
            sessions.put(sessionId, previous);

            int cmdIndex = sessionCommandIndex.get(sessionId);
            List<Command> commands = sessionCommands.get(sessionId);
            return buildResponse(sessionId, previous, commands.get(cmdIndex));

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String handleNewTrace(JsonObject req) {
        try {
            String sessionId = req.get("sessionId").getAsString();
            A4Solution current = sessions.get(sessionId);
            if (current == null) return error("Session not found: " + sessionId);

            // New Trace: mesma configuração, trace diferente (Analyzer: fork(-2));
            // em modelos estruturais não há traces, por isso usa next()
            A4Solution next = isTemporalModel(sessionId) ? current.fork(-2) : current.next();

            if (!next.satisfiable()) {
                JsonObject response = new JsonObject();
                response.addProperty("sessionId", sessionId);
                response.addProperty("satisfiable", false);
                response.addProperty("hasNext", false);
                response.addProperty("noMoreInstances", true);
                return gson.toJson(response);
            }

            sessions.put(sessionId, next);
            sessionHistory.get(sessionId).add(next);

            int cmdIndex = sessionCommandIndex.get(sessionId);
            List<Command> commands = sessionCommands.get(sessionId);
            return buildResponse(sessionId, next, commands.get(cmdIndex));

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String handleNewConfig(JsonObject req) {
        try {
            String sessionId = req.get("sessionId").getAsString();
            A4Solution current = sessions.get(sessionId);
            if (current == null) return error("Session not found: " + sessionId);

            if (!current.hasConfigs()) {
                JsonObject response = new JsonObject();
                response.addProperty("sessionId", sessionId);
                response.addProperty("satisfiable", false);
                response.addProperty("hasNext", false);
                response.addProperty("noMoreInstances", true);
                return gson.toJson(response);
            }

            try {
                A4Solution newSolution = isTemporalModel(sessionId) ? current.fork(-1) : current.next();

                if (!newSolution.satisfiable()) {
                    JsonObject response = new JsonObject();
                    response.addProperty("sessionId", sessionId);
                    response.addProperty("satisfiable", false);
                    response.addProperty("hasNext", false);
                    response.addProperty("noMoreInstances", true);
                    return gson.toJson(response);
                }

                sessions.put(sessionId, newSolution);
                sessionHistory.get(sessionId).add(newSolution);

                int cmdIndex = sessionCommandIndex.get(sessionId);
                List<Command> commands = sessionCommands.get(sessionId);
                return buildResponse(sessionId, newSolution, commands.get(cmdIndex));

            } catch (Exception e) {
                return error("New Config not supported for this model: " + e.getMessage());
            }

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String handleNewInit(JsonObject req) {
        try {
            String sessionId = req.get("sessionId").getAsString();
            A4Solution current = sessions.get(sessionId);
            if (current == null) return error("Session not found: " + sessionId);

            A4Solution forked = current.fork(0);

            if (!forked.satisfiable()) {
                JsonObject response = new JsonObject();
                response.addProperty("sessionId", sessionId);
                response.addProperty("satisfiable", false);
                response.addProperty("hasNext", false);
                response.addProperty("noMoreInstances", true);
                return gson.toJson(response);
            }

            sessions.put(sessionId, forked);
            sessionHistory.get(sessionId).add(forked);

            int cmdIndex = sessionCommandIndex.get(sessionId);
            List<Command> commands = sessionCommands.get(sessionId);
            return buildResponse(sessionId, forked, commands.get(cmdIndex));

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String handleNewFork(JsonObject req) {
        try {
            String sessionId = req.get("sessionId").getAsString();
            A4Solution current = sessions.get(sessionId);
            if (current == null) return error("Session not found: " + sessionId);

            if (!isTemporalModel(sessionId)) {
                return error("New Fork is only available for temporal models.");
            }

            int stateIndex = req.has("stateIndex") ? req.get("stateIndex").getAsInt() : 0;
            // New Fork: mantém os estados 0..stateIndex e diverge a partir do seguinte
            // (Analyzer: fork(current + 1))
            A4Solution forked = current.fork(stateIndex + 1);

            if (!forked.satisfiable()) {
                JsonObject response = new JsonObject();
                response.addProperty("sessionId", sessionId);
                response.addProperty("satisfiable", false);
                response.addProperty("hasNext", false);
                response.addProperty("noMoreInstances", true);
                return gson.toJson(response);
            }

            sessions.put(sessionId, forked);
            sessionHistory.get(sessionId).add(forked);

            int cmdIndex = sessionCommandIndex.get(sessionId);
            List<Command> commands = sessionCommands.get(sessionId);
            return buildResponse(sessionId, forked, commands.get(cmdIndex));

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String handleClose(JsonObject req) {
        String sessionId = req.get("sessionId").getAsString();
        sessions.remove(sessionId);
        sessionCommands.remove(sessionId);
        sessionModules.remove(sessionId);
        sessionCommandIndex.remove(sessionId);
        sessionHistory.remove(sessionId);

        JsonObject response = new JsonObject();
        response.addProperty("status", "closed");
        response.addProperty("sessionId", sessionId);
        return gson.toJson(response);
    }

    private static String handleEvaluate(JsonObject req) {
        try {
            String sessionId = req.get("sessionId").getAsString();
            String expression = req.get("expression").getAsString();
            int stateIndex = req.has("stateIndex") ? req.get("stateIndex").getAsInt() : 0;

            A4Solution solution = sessions.get(sessionId);
            Module world = sessionModules.get(sessionId);

            if (solution == null || world == null) {
                return error("Session not found: " + sessionId);
            }

            // Parsear a expressão no contexto do módulo atual
            edu.mit.csail.sdg.ast.Expr expr =
                CompUtil.parseOneExpression_fromString(world, expression);

            // Avaliar a expressão no estado especificado
            Object result = solution.eval(expr, stateIndex);

            JsonObject response = new JsonObject();
            response.addProperty("sessionId", sessionId);
            response.addProperty("expression", expression);
            response.addProperty("result", result != null ? result.toString() : "{}");
            return gson.toJson(response);

        } catch (Err e) {
            return error("Evaluation error: " + e.getMessage());
        } catch (Exception e) {
            return error("Error: " + e.getMessage());
        }
    }

    // Um modelo é temporal se tiver alguma sig ou field 'var'.
    // (A4Solution.isTemporal() devolve true também para modelos estruturais no Alloy 6.)
    private static boolean isTemporalModel(String sessionId) {
        Module world = sessionModules.get(sessionId);
        if (world == null) return false;
        for (Sig s : world.getAllReachableSigs()) {
            if (s.isVariable != null) return true;
            for (Sig.Field f : s.getFields()) {
                if (f.isVariable != null) return true;
            }
        }
        return false;
    }

    private static String buildResponse(String sessionId, A4Solution solution, Command command) {
        return gson.toJson(buildResponseObject(sessionId, solution, command));
    }

    private static JsonObject buildResponseObject(String sessionId, A4Solution solution, Command command) {
        JsonObject response = new JsonObject();
        boolean sat = solution.satisfiable();
        response.addProperty("sessionId", sessionId);
        response.addProperty("commandLabel", command.toString());
        response.addProperty("satisfiable", sat);
        response.addProperty("hasNext", sat);
        response.addProperty("isTemporal", isTemporalModel(sessionId));
        // Uma solução UNSAT não tem instância (eval == null): não pedir dados da trace
        response.addProperty("traceLength", sat ? solution.getTraceLength() : 0);
        response.addProperty("loopState", sat ? solution.getLoopState() : -1);
        response.addProperty("hasConfigs", sat && solution.hasConfigs());

        // Subset sigs (declaradas com 'in'), para o grafo as distinguir das sigs-pai de 'extends'
        JsonArray subsetSigs = new JsonArray();
        Module world = sessionModules.get(sessionId);
        if (world != null) {
            for (Sig s : world.getAllReachableSigs()) {
                if (s instanceof Sig.SubsetSig) subsetSigs.add(s.label);
            }
        }
        response.add("subsetSigs", subsetSigs);

        // Indicar se há instância anterior no histórico
        List<A4Solution> history = sessionHistory.get(sessionId);
        response.addProperty("hasPrevious", history != null && history.size() > 1);

        if (solution.satisfiable()) {
            response.addProperty("instance", solution.toString());
        }

        return response;
    }

    // --- Opções, posições e message log ---

    private static boolean optBoolean(JsonObject req, String key, boolean def) {
        return req.has(key) && !req.get(key).isJsonNull() ? req.get(key).getAsBoolean() : def;
    }

    // Posição no ficheiro (linhas e colunas a partir de 1, fim inclusivo, como na classe Pos)
    private static JsonObject posJson(Pos p) {
        JsonObject o = new JsonObject();
        o.addProperty("file", p.filename);
        o.addProperty("line", p.y);
        o.addProperty("col", p.x);
        o.addProperty("endLine", p.y2);
        o.addProperty("endCol", p.x2);
        return o;
    }

    private static JsonArray posArray(Set<Pos> positions) {
        JsonArray arr = new JsonArray();
        for (Pos p : positions) arr.add(posJson(p));
        return arr;
    }

    // Recolhe o que o Analyzer mostra no message log (scopes, solver, tamanho do problema,
    // tempos, resultado) e os warnings, que a API só comunica através do A4Reporter
    private static class SessionReporter extends A4Reporter {
        final List<String> log = new ArrayList<>();
        final JsonArray warnings = new JsonArray();
        private long startTime = System.currentTimeMillis();
        // Estatísticas acumuladas da resolução (nos modelos temporais, o solve é chamado
        // uma vez por cada número de passos tentado), como no Analyzer
        private int startStep = -1, seenStep = -1, startCount = 0;
        private int primaryVars = 0, totalVars = 0, clauses = 0;
        private int solveLine = -1;

        JsonArray logJson() {
            JsonArray arr = new JsonArray();
            for (String line : log) arr.add(line);
            return arr;
        }

        @Override
        public void warning(ErrorWarning msg) {
            JsonObject w = posJson(msg.pos);
            w.addProperty("message", msg.msg.trim());
            warnings.add(w);
            log.add("Warning: " + msg.msg.trim() + " (line " + msg.pos.y + ", column " + msg.pos.x + ")");
        }

        @Override
        public void scope(String msg) {
            log.add(msg.trim());
        }

        @Override
        public void bound(String msg) {
            log.add(msg.trim());
        }

        @Override
        public void translate(String solver, int bitwidth, int maxseq, int mintrace, int maxtrace,
                              int skolemDepth, int symmetry, String strat) {
            startTime = System.currentTimeMillis();
            startStep = -1; seenStep = -1; startCount = 0;
            primaryVars = 0; totalVars = 0; clauses = 0;
            solveLine = -1;
            log.add("Solver=" + solver + (maxtrace < 1 ? "" : " Steps=" + mintrace + ".." + maxtrace)
                + " Bitwidth=" + bitwidth + " MaxSeq=" + maxseq
                + (skolemDepth == 0 ? "" : " SkolemDepth=" + skolemDepth)
                + " Symmetry=" + (symmetry > 0 ? String.valueOf(symmetry) : "OFF") + " Mode=" + strat);
        }

        // Scopes efetivos de cada sig, depois de aplicados os scopes do comando
        @Override
        public void actualScopes(Iterable<Sig> sigs, Map<PrimSig, Integer> scopes, Set<Sig> exacts) {
            StringBuilder sb = new StringBuilder();
            for (Sig s : sigs) {
                if (s.builtin || s.isSubset != null) continue;
                String name = s.label.startsWith("this/") ? s.label.substring(5) : s.label;
                if (sb.length() > 0) sb.append(", ");
                if (exacts.contains(s)) sb.append("exactly ").append(scopes.get(s)).append(" ").append(name);
                else if (scopes.containsKey(s)) sb.append(scopes.get(s)).append(" ").append(name);
                else sb.append(name).append("????");
            }
            log.add("Actual scopes: " + sb);
        }

        // Uma única linha com os valores acumulados, atualizada a cada chamada
        @Override
        public void solve(int step, int pv, int tv, int cl) {
            if (startStep < 0) startStep = step;
            if (startStep == step) startCount++;
            seenStep = Math.max(seenStep, step);
            primaryVars += pv;
            totalVars += tv;
            clauses += cl;
            StringBuilder sb = new StringBuilder();
            if (startCount > 1) sb.append(startCount).append(" configs. ");
            if (seenStep > 0) sb.append(startStep).append("..").append(seenStep).append(" steps. ");
            sb.append(totalVars).append(" vars. ").append(primaryVars).append(" primary vars. ")
              .append(clauses).append(" clauses. ")
              .append(System.currentTimeMillis() - startTime).append("ms.");
            if (solveLine >= 0) log.set(solveLine, sb.toString());
            else { solveLine = log.size(); log.add(sb.toString()); }
        }

        @Override
        public void minimizing(Object command, int before) {
            log.add("Minimizing the unsat core of " + before + " entries...");
        }

        @Override
        public void minimized(Object command, int before, int after) {
            log.add("The unsat core was minimized from " + before + " to " + after + " entries.");
        }

        @Override
        public void resultSAT(Object command, long solvingTime, Object solution) {
            result(command, solvingTime, true);
        }

        @Override
        public void resultUNSAT(Object command, long solvingTime, Object solution) {
            result(command, solvingTime, false);
        }

        // Mesmas mensagens que o Analyzer, incluindo a comparação com o 'expect'
        private void result(Object command, long solvingTime, boolean sat) {
            if (!(command instanceof Command)) return;
            Command cmd = (Command) command;
            String outcome = cmd.check
                ? (sat ? "Counterexample found. Assertion is invalid." : "No counterexample found. Assertion may be valid.")
                : (sat ? "Instance found. Predicate is consistent." : "No instance found. Predicate may be inconsistent.");
            String expectation = "";
            if (cmd.expects == 0 || cmd.expects == 1) {
                expectation = (cmd.expects == 1) == sat ? " As expected." : " Contrary to expectation.";
            }
            log.add(outcome + " " + solvingTime + "ms." + expectation);
        }
    }

    // Metamodelo: assinaturas como nós, extends/in e fields como arestas (como o Show Metamodel do Analyzer)
    private static String handleMetamodel(JsonObject req) {
        try {
            String filePath = req.get("file").getAsString();
            int resolutionMode = optBoolean(req, "implicitThis", false) ? 2 : 1;
            Module world = CompUtil.parseEverything_fromFile(new A4Reporter(), null, filePath, resolutionMode);

            Map<String, JsonObject> nodes = new LinkedHashMap<>();
            JsonArray links = new JsonArray();
            Set<String> linkKeys = new HashSet<>();

            for (Sig s : world.getAllReachableUserDefinedSigs()) {
                if (s.isPrivate != null) continue;            // ex.: Ord do util/ordering
                JsonObject node = metaNode(nodes, s);
                JsonArray labels = node.getAsJsonArray("labels");
                if (s.isAbstract != null) labels.add("abstract");
                if (s.isOne != null)      labels.add("one");
                if (s.isLone != null)     labels.add("lone");
                if (s.isSome != null)     labels.add("some");
                if (s.isVariable != null) labels.add("var");

                if (s instanceof PrimSig) {
                    PrimSig parent = ((PrimSig) s).parent;
                    if (parent != null && parent != Sig.UNIV) {
                        metaNode(nodes, parent);
                        metaLink(links, linkKeys, metaName(s), metaName(parent), "extends");
                    }
                } else if (s instanceof SubsetSig) {
                    for (Sig p : ((SubsetSig) s).parents) {
                        metaNode(nodes, p);
                        metaLink(links, linkKeys, metaName(s), metaName(p), "in");
                    }
                }

                for (Field f : s.getFields()) {
                    if (f.isPrivate != null) continue;
                    String fname = f.isVariable != null ? f.label + " (var)" : f.label;
                    for (List<PrimSig> cols : f.type().fold()) {      // cols.get(0) é a sig dona
                        for (PrimSig c : cols) metaNode(nodes, c);
                        List<String> middle = new ArrayList<>();
                        for (int i = 1; i < cols.size() - 1; i++) middle.add(metaName(cols.get(i)));
                        String label = middle.isEmpty() ? fname : fname + " [" + String.join(", ", middle) + "]";
                        metaLink(links, linkKeys, metaName(cols.get(0)), metaName(cols.get(cols.size() - 1)), label);
                    }
                }
            }

            JsonArray nodeArray = new JsonArray();
            nodes.values().forEach(nodeArray::add);
            JsonObject response = new JsonObject();
            response.add("nodes", nodeArray);
            response.add("links", links);
            return gson.toJson(response);

        } catch (Err e) {
            return error(e.getMessage());
        }
    }

    private static String metaName(Sig s) {
        return s.label.startsWith("this/") ? s.label.substring(5) : s.label;
    }

    // Cria o nó se ainda não existir; o grupo (cor) é a assinatura de topo da hierarquia
    private static JsonObject metaNode(Map<String, JsonObject> nodes, Sig s) {
        return nodes.computeIfAbsent(metaName(s), id -> {
            Sig top = s;
            while (top instanceof PrimSig && ((PrimSig) top).parent != null && ((PrimSig) top).parent != Sig.UNIV)
                top = ((PrimSig) top).parent;
            if (top instanceof SubsetSig && !((SubsetSig) top).parents.isEmpty())
                top = ((SubsetSig) top).parents.get(0);
            JsonObject n = new JsonObject();
            n.addProperty("id", id);
            n.addProperty("group", s.builtin ? "builtin" : metaName(top));
            n.add("labels", new JsonArray());
            return n;
        });
    }

    private static void metaLink(JsonArray links, Set<String> keys, String src, String tgt, String label) {
        if (!keys.add(src + "|" + tgt + "|" + label)) return;
        JsonObject l = new JsonObject();
        l.addProperty("source", src);
        l.addProperty("target", tgt);
        l.addProperty("label", label);
        links.add(l);
    }

    private static String error(String message) {
        JsonObject response = new JsonObject();
        response.addProperty("error", message != null ? message : "Unknown error");
        return gson.toJson(response);
    }
}