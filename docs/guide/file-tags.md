# Tag files and folders

Put the path of a file, a folder or a part of a file in your prompt by picking it from a list.

1. Type `@` at the start of the input or after a space. A list of files and folders opens above the input: 📄 for a file, 📁 for a folder, 📚 for an attached reference repository.
2. Type part of a name, such as `@inpt`. The list matches loosely, so typos still find the file.
3. Press Up and Down to choose a row.
4. Press Tab on a folder to open it: the input gets `@src/tui/` and the list shows what is in it. Press Tab on a reference to search inside it.
5. Press Enter to tag the row. The input gets `@src/tui/Input.tsx` and a space, and the list closes.
6. To point at lines, type `#L10-20` after the path: `@src/a.ts#L10-20`.
7. Press Escape to close the list. It opens again when you change the text.

## What happens

The model gets the tag as text, not the file's contents. It reads the file itself when it needs to. A path with spaces is quoted: `@"docs/my notes.md"`. Tags show in the accent color in the input and in your sent message.

A tagged folder also sends the model a list of what is directly in it, as it was when you sent the message: folders first, then files, by name. The list leaves out `.git` and gitignored entries, and stops after 200 names. It is not shown in the chat, and it does not change later in the session.

Tau indexes the session's folder when the chat opens and follows file changes after that. In a large folder, the list says `Indexing… 41,200 files` until the first index is ready. Gitignored files are left out.

A file in an attached reference repository is tagged with its full path, such as `@~/.tau/references/opencode/src/a.ts`. Type `@opencode/` to search only that reference. In the list, Tab on a reference opens it the same way, and Enter tags the whole reference by its folder, such as `@~/.tau/references/opencode/`.

Files you pick move up the list the next time you type the same query. Tau keeps this ranking in `~/.tau/files/`.

## Limits

- File search is off in your home folder and at the file system root, which hold too many files. Start Tau in a project folder.
- `@` inside a word, such as `me@example.com`, opens no list.
- The list shows up to 10 files and folders, then the matching references.
