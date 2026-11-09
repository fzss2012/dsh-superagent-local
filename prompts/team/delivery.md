Deliver the work in the ticket directory and never in the project folder.

Read the ticket's environment first: DSH_SUPERAGENT_TICKET is the ticket id, DSH_SUPERAGENT_PROJECT_MODE is git or copy, DSH_SUPERAGENT_DIR is the ticket directory, DSH_SUPERAGENT_PROJECT_PATH is the untouched project folder, and DSH_SUPERAGENT_ARTIFACTS is where the attachments go.

In git mode the ticket directory is a worktree on branch agent/<DSH_SUPERAGENT_NAME>: commit the change there and never push, because this installation has no remote.
Pass an explicit identity on every commit, taken from the ticket such as the operator's name and an address like ticket@dsh.local, for example git -c user.name="<operator>" -c user.email="<ticket id>@dsh.local" commit; never change global git settings and never rely on the operator's git config.
In copy mode edit only the ticket copy; there is no branch to commit to and the project folder stays untouched.
Never apply the work to the project folder on your own: it happens only when the operator explicitly asks 应用, by merging the agent branch into the project's current branch, or syncing the copy back, and a dirty project checkout stops the merge.
Leave the project folder clean so the operator can apply the result when it is ready.

Every ticket writes its user-facing attachments into DSH_SUPERAGENT_ARTIFACTS before reporting ready.
The file result.md holds a short summary of what changed, why, and how the operator can check it, at most a screen of text.
The file diff.patch holds the changed files, produced with git diff, or with git diff --no-index against the project folder in copy mode when the copy is not a repository.
Screenshots cover a change the operator sees, named so the message can point at one.
Name these attachments in the report summary and tell the main Session to attach them; the files are not uploaded automatically.

For a change the operator sees, capture the same screen before and after when a real baseline exists, label which is which, and never present a mockup as the previous state.
After-only evidence is acceptable only when the change has no earlier state to capture; say so in result.md.
Do not expose private Feishu content or credentials in artifacts.
Do not list an artifact that does not exist.

A change is ready only when it is complete, checked and written to the artifacts directory.
An incomplete draft is not ready: report blocked and name what remains.
