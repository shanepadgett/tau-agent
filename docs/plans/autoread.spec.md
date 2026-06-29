When `/tau-edit` is run in TUI mode and the user selects Tau resources, the system shall:

- prepare edit context without asking for an edit prompt;
- prepare edit context without asking whether to attach reference repos.

When `/tau-edit` has prepared edit context, the system shall:

- leave the editor empty so the user can type the next prompt;
- not submit a user message or trigger an agent turn;
- request autoread for every file that belongs to the selected resources.

When `/tau-edit` has prepared edit context, the system shall inject one hidden context item into the conversation.

When the `/tau-edit` hidden context item is injected, the system shall start it with:

- `# /tau-edit context`
- `Autoread files are visible context items in this conversation.`
- `Do not reread autoread files before answering questions or making changes.`

When the `/tau-edit` hidden context item is injected, the system shall include root file pointers under `Root files:`.

When the `/tau-edit` hidden context item is injected, the system shall include shared file pointers under `Shared files:`.

When the `/tau-edit` hidden context item is injected, the system shall include selected resource metadata under `Selected resources:`.

When root file pointers are included, the system shall include `Root files are pointers only. Read only when directly needed.` before the root file list.

When shared file pointers are included, the system shall include `Shared files are pointers only. Read only when directly needed.` before the shared file list.

When selected resource metadata is included, the system shall include resource name, kind, and path without listing autoread files.

When autoread is requested for files, the system shall read each requested file in full.

When autoread reads a file, the system shall inject that file content as one visible context item in the conversation for that file.

When an autoread conversation item is rendered, the system shall show a row with a status dot, the `autoread` name, and the file path.

When an autoread row is reading, the system shall show the status dot as dim.

When an autoread row has read the file, the system shall show the status dot as success.

When an autoread row is marked pruned, the system shall show the status dot as success and the `autoread` name as warning colored.

When any Tau-rendered tool row is marked pruned, the system shall use the same row-state mechanism to color the row name as pruned.

When an autoread event carries file paths, the event shall carry paths and metadata, not file contents.
