package com.alloy.server;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.alloy4.Err;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.ast.Module;
import edu.mit.csail.sdg.parser.CompUtil;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;
import edu.mit.csail.sdg.ast.Sig;

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

            A4Reporter reporter = new A4Reporter();
            Module world = CompUtil.parseEverything_fromFile(reporter, null, filePath);
            List<Command> commands = world.getAllCommands();

            if (commandIndex >= commands.size()) {
                return error("Command index out of range");
            }

            Command command = commands.get(commandIndex);
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

            A4Solution solution = TranslateAlloyToKodkod.execute_command(
                reporter, world.getAllReachableSigs(), command, options
            );

            sessions.put(sessionId, solution);
            sessionCommands.put(sessionId, commands);
            sessionModules.put(sessionId, world);
            sessionCommandIndex.put(sessionId, commandIndex);
            sessionHistory.put(sessionId, new ArrayList<>(List.of(solution)));

            return buildResponse(sessionId, solution, command);

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

        // Indicar se há instância anterior no histórico
        List<A4Solution> history = sessionHistory.get(sessionId);
        response.addProperty("hasPrevious", history != null && history.size() > 1);

        if (solution.satisfiable()) {
            response.addProperty("instance", solution.toString());
        }

        return gson.toJson(response);
    }

    private static String error(String message) {
        JsonObject response = new JsonObject();
        response.addProperty("error", message != null ? message : "Unknown error");
        return gson.toJson(response);
    }
}