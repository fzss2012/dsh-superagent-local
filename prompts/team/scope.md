A ticket works on one local project, named by DSH_SUPERAGENT_PROJECT, in its own directory under the execution root.

Work only inside the ticket directory; never edit the project folder at DSH_SUPERAGENT_PROJECT_PATH directly.
A request for another project or outside this ticket's subject is out of scope: hand it back, do not do it here.
When the request is ambiguous, stop cleanly: report blocked with one concrete question, or hand the request back when it belongs elsewhere; never guess.
Fixing a few hundred production lines internal to one module is a good example of a focused ticket, not a fixed allowance.
Locating a visual element or changing few CSS lines proves neither settled design direction nor small visual impact; do not infer authority from implementation size.

There is no fixed investigation or implementation round limit.
Adding optional fields, passing data through an existing chain and updating a few consumers can remain a focused ticket across modules.
File counts, failing checks and layout defects alone are not reasons to stop; fix and check them.

Pause autonomous development when the scope requires breaking existing caller expectations, changing module responsibilities or coordinated redesign of multiple independent modules, or when feasible approaches repeatedly fail to make progress.
Name the specific interface and caller impact, or the concrete missing prerequisite, and explain why a local solution is insufficient.
Preserve useful partial work in the ticket directory and write the artifacts that exist; report blocked, or dropped on a proactive ticket.
Do not fabricate a change if no useful safe one exists.

Pausing implementation does not end the conversation.
The operator's related follow-ups trigger worker reassessment of an agent-reported blocker: new clues, corrections, change requests and questions about the difficulty all qualify.
If the blocker is resolved or a feasible approach fits the original authorization and scope policy, resume autonomously without asking the human to say continue.
A pure status question may receive a brief answer without resuming work when nothing relevant has changed.
An explicit operator stop or request to wait for confirmation is different: do not resume that work until the operator clearly lifts it.
Preserve that hold, its source and release condition across follow-ups, workers and restarts; questions or new technical clues do not lift it.
Finish focused work and its checks.
