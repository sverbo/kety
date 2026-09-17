/**
 * Single source of truth for Kety FAQ copy and structure.
 * Imported by desktop-app.
 */

/** Inline segments: `bold` → <strong>; `href` → <a> (e.g. mailto). */
export type FaqProsePart = { text: string; bold?: boolean; href?: string };

export type FaqBlock =
  | { type: "p"; text: string }
  | { type: "prose"; parts: readonly FaqProsePart[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "h3"; text: string }
  | { type: "links"; items: { href: string; label: string }[] };

export type FaqSection = { title: string; blocks: FaqBlock[] };

export type FaqCategory = { categoryTitle: string; sections: FaqSection[] };

export const FAQ_CATEGORIES: FaqCategory[] = [
  {
    categoryTitle: "Privacy & background",
    sections: [
      {
        title: "What does Kety do in the background?",
        blocks: [
          {
            type: "p",
            text: "One thing, and it never leaves your computer: Kety indexes your captures so the AI assistant can find them.",
          },
          {
            type: "p",
            text: "Kety does not passively record, listen, monitor your activity, or phone home. There is no company server behind the app: it runs entirely on your machine.",
          },
          {
            type: "p",
            text: "Indexing starts by itself shortly after a capture is saved and works through a few captures at a time, so your captures are searchable without you having to do anything. It all happens locally. You can pause it with \"Index captures automatically\" under Settings → AI tasks - captures then simply queue up until you turn it back on.",
          },
          { type: "p", text: "Everything else only happens when you:" },
          {
            type: "ul",
            items: ["Press a shortcut", "Click a button"],
          },
          {
            type: "p",
            text: "No hidden tracking, no always-on recording, no network calls you did not ask for.",
          },
        ],
      },
      {
        title: "Is my data stored anywhere besides my computer?",
        blocks: [
          { type: "p", text: "No." },
          {
            type: "p",
            text: "Captures, conversation history, tags, and settings all live in a local SQLite database on your machine. Nothing is uploaded or synced anywhere by default.",
          },
          {
            type: "p",
            text: "The only network calls Kety makes are the ones you ask for:",
          },
          {
            type: "ul",
            items: [
              "A direct call to OpenAI, if you add your own API key and pick an OpenAI model for a task",
              "Downloading a local model when you install one from Settings",
              "Uploading to your own storage bucket, if you connect one and choose to share something as a link",
              "The Google Meet Chrome extension talking to the app on 127.0.0.1 (your own machine)",
            ],
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "Permissions",
    sections: [
      {
        title: "What permissions does Kety require?",
        blocks: [
          {
            type: "p",
            text: "Kety only asks for permissions when needed, depending on what you want to use:",
          },
          { type: "h3", text: "Screen recording permission" },
          {
            type: "ul",
            items: [
              "Required for screenshots and screen recordings",
              "Used only when you trigger a capture",
            ],
          },
          { type: "h3", text: "Microphone access" },
          {
            type: "ul",
            items: [
              "Required for dictation or audio recording",
              "Used only when you actively record",
            ],
          },
          { type: "h3", text: "Accessibility access" },
          {
            type: "ul",
            items: [
              "Used to enable features like text highlighting, inserting dictated text into fields, and interacting with your current context",
            ],
          },
          {
            type: "p",
            text: "Kety never uses these permissions unless you explicitly trigger an action.",
          },
          {
            type: "p",
            text: "Two things that surprise people: macOS only applies a new screen recording permission to an app that starts fresh, so Kety asks you to restart it after you grant that one. And after you update Kety, it asks for screen recording and microphone again, so that each new version starts from an answer you actually gave.",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "Profiles & storage",
    sections: [
      {
        title: "Why does Kety ask me to create a profile?",
        blocks: [
          {
            type: "p",
            text: "Kety supports multiple people using the same computer. Creating a local profile keeps each person's captures, conversations, and settings separate - no account, no password, no internet connection required.",
          },
          {
            type: "p",
            text: "You can create additional profiles, rename them, or switch between them at any time under Settings → Account. Switching reloads the app so everything comes back scoped to that profile.",
          },
          {
            type: "p",
            text: "Removing a profile only takes it off the list - its captures and knowledge stay on disk, but nothing in the app can reach them any more.",
          },
        ],
      },
      {
        title: "What happens if I change or lose my computer?",
        blocks: [
          {
            type: "p",
            text: "Everything in Kety lives only on your computer: captures, conversation history, tags, and settings. There is no cloud backup by default.",
          },
          {
            type: "p",
            text: "If you want to move to a new machine or keep a backup, use the download button in the Captures tab toolbar to save a ZIP copy of your captures before switching computers. To keep only part of them, select the captures you want and use Share, then choose to save the file.",
          },
        ],
      },
      {
        title: "How much storage does Kety use on my computer?",
        blocks: [
          {
            type: "p",
            text: "It depends on what you capture:",
          },
          {
            type: "ul",
            items: [
              "Screen recordings can take significant space",
              "Screenshots take some space",
              "Text captures take almost none",
            ],
          },
          {
            type: "p",
            text: "Documents you capture are stored locally too, along with the search index built from them. From the Captures tab you can delete captures one at a time or several at once, with their files, to free up space.",
          },
          {
            type: "p",
            text: "Local models take their own space - from under 100 MB to a few GB each. You can remove any you no longer use under Settings → AI tasks → Local models.",
          },
        ],
      },
      {
        title: "Is my data encrypted?",
        blocks: [
          {
            type: "p",
            text: "Data is stored locally in a per-profile SQLite database and is not encrypted at rest. Profiles are kept separate within the app, but anyone with direct access to your computer and enough technical knowledge could potentially access another profile's local files.",
          },
          {
            type: "p",
            text: "If that matters to you, use your operating system's full-disk encryption (e.g. FileVault on macOS).",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "Performance",
    sections: [
      {
        title: "Does Kety slow down my computer?",
        blocks: [
          {
            type: "p",
            text: "Not by default.",
          },
          {
            type: "p",
            text: "The only time Kety may use noticeable resources is when running local processing, such as:",
          },
          {
            type: "ul",
            items: [
              "Transcribing audio or video",
              "Running dictation and tagging",
              "Scanning for sensitive data",
              "Summarizing documents",
              "Indexing captures for search (embedding)",
            ],
          },
          {
            type: "p",
            text: "Most of this only happens when you trigger it. Indexing is the exception - it runs on its own in the background, a few captures at a time, and you can pause it under Settings → AI tasks.",
          },
          {
            type: "p",
            text: "You can reduce resource usage in Settings:",
          },
          {
            type: "ul",
            items: [
              "Use a smaller local model (Whisper or Qwen)",
              "Limit summaries to the first pages of documents",
              "Lower parallelism for indexing and dictation",
            ],
          },
          {
            type: "p",
            text: "If your computer is not powerful enough for local models, you can use your own OpenAI API key instead - the work then runs on OpenAI's servers rather than on your machine.",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "Models & your API key",
    sections: [
      {
        title: "Local models vs. your own API key - what's the difference?",
        blocks: [
          {
            type: "p",
            text: "For most tasks in Kety (dictation, transcription, summaries, tags, sensitive-data scanning, making captures searchable, the AI assistant), you choose between two kinds of models per task, under Settings → AI tasks:",
          },
          {
            type: "ul",
            items: [
              "Local models (Whisper for audio, Qwen for text, Qwen3-Embedding for search) - Free, fully offline, no data ever leaves your device. Trade-offs: they use disk space (a few GB per model), consume RAM/CPU while running, and may be less accurate than the largest cloud models.",
              "Your own OpenAI API key - Uses OpenAI's models directly from your device. Trade-off: your data for that request is sent to OpenAI, and you pay OpenAI directly for usage. Your key never leaves your device except in that direct call.",
            ],
          },
          {
            type: "p",
            text: "You can mix both: for example, local Whisper for dictation and OpenAI for the assistant, or the other way around.",
          },
        ],
      },
      {
        title: "Which local models does Kety use, and how big are they?",
        blocks: [
          {
            type: "p",
            text: "Three families, all running on your device:",
          },
          {
            type: "ul",
            items: [
              "Whisper, for turning speech into text - from about 75 MB to 3 GB depending on the size you pick",
              "Qwen, for writing, summarizing and tagging - from about 500 MB to 2.5 GB",
              "Qwen3-Embedding, for making your captures searchable - about 650 MB or 2.5 GB",
            ],
          },
          {
            type: "p",
            text: "The search model is a separate choice from the writing model, so you can be generous with one and frugal with the other.",
          },
          {
            type: "p",
            text: "Kety ships without any of them. Under Settings → AI tasks → Local models you can see each download size, install one, and switch between sizes - smaller models are faster and lighter, larger models are more accurate. Models are downloaded once and stay on disk until you remove them from Settings.",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "OpenAI: keys & usage",
    sections: [
      {
        title: "How do I create an API key?",
        blocks: [
          {
            type: "p",
            text: "You can create an API key directly from OpenAI:",
          },
          {
            type: "links",
            items: [
              {
                href: "https://platform.openai.com/api-keys",
                label: "https://platform.openai.com/api-keys",
              },
            ],
          },
          {
            type: "ol",
            items: [
              "Create an account or log in",
              "Click “Create new secret key”",
              "Copy the key and paste it into Kety under Settings → AI tasks → API key (OpenAI)",
            ],
          },
          {
            type: "p",
            text: "Make sure to store it securely - you won't be able to see it again on OpenAI's side later.",
          },
        ],
      },
      {
        title: "How can I track my API usage and spending?",
        blocks: [
          {
            type: "p",
            text: "Kety does not track or bill your API usage - your key talks directly to OpenAI, so all usage and cost tracking happens on their side.",
          },
          {
            type: "links",
            items: [
              {
                href: "https://platform.openai.com/usage",
                label: "https://platform.openai.com/usage",
              },
            ],
          },
          {
            type: "p",
            text: "There you can see your costs, set spending limits, and monitor requests over time.",
          },
        ],
      },
      {
        title: "What if I think my API key has been leaked?",
        blocks: [
          {
            type: "p",
            text: "Your API key never leaves your device except in direct calls to OpenAI.",
          },
          {
            type: "p",
            text: "For security:",
          },
          {
            type: "ul",
            items: [
              "Keys are stored locally in your profile",
              "After saving, only the beginning and the last four characters are shown - the middle is hidden",
              "You cannot copy the full key back out of the app",
            ],
          },
          {
            type: "p",
            text: "If you're still concerned, revoke the key from OpenAI and generate a new one:",
          },
          {
            type: "links",
            items: [
              {
                href: "https://platform.openai.com/api-keys",
                label: "https://platform.openai.com/api-keys",
              },
            ],
          },
          {
            type: "p",
            text: "Then paste the new key into Kety under Settings → AI tasks → API key (OpenAI).",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "Knowledge base",
    sections: [
      {
        title: "How do my captures become searchable?",
        blocks: [
          {
            type: "p",
            text: "On their own. Every capture is indexed in the background shortly after it is saved - split into passages and turned into a form that can be searched by meaning, using your chosen search model. After that the AI assistant and the local MCP server can find it. There is no button to press.",
          },
          {
            type: "p",
            text: "Each capture tells you where it stands:",
          },
          {
            type: "ul",
            items: [
              "Waiting - saved, queued, not searchable yet",
              "Indexing… - being worked on right now",
              "No badge at all - the assistant can find it",
              "Not indexed - something went wrong; click it to try again",
            ],
          },
          {
            type: "p",
            text: "You can still edit a capture after it has been indexed - Kety just indexes it again with the new text.",
          },
          {
            type: "p",
            text: "If you would rather the assistant ignored something, select it and use \"Remove from assistant\". The capture stays in your list, it simply stops turning up in answers, and it shows \"Hidden from assistant\". \"Add back to assistant\" undoes that.",
          },
        ],
      },
      {
        title: "Can I use Kety without a search model configured?",
        blocks: [
          {
            type: "p",
            text: "Yes. You can capture, dictate, and use the Captures tab without one. Captures simply stay marked Waiting - nothing is lost, and they index themselves as soon as a model is available.",
          },
          {
            type: "p",
            text: "Pick one under Settings → AI tasks → Local models. It can run on your device, or you can use OpenAI's embedding model with your own API key if you would rather not download anything.",
          },
        ],
      },
      {
        title: "Can I connect Kety to Claude Code or another MCP-compatible AI?",
        blocks: [
          {
            type: "p",
            text: "Yes. Kety runs a small server on your own machine so any MCP-compatible client can search your knowledge base.",
          },
          {
            type: "p",
            text: "Copy the ready-made configuration from Settings → MCP and paste it into your client. It only accepts connections from your own computer, so there is no key or password to hand over.",
          },
          {
            type: "p",
            text: "It searches your own knowledge. Assistants other people shared with you are not included.",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "Sharing",
    sections: [
      {
        title: "Can I share what I know with someone else?",
        blocks: [
          {
            type: "p",
            text: "Yes. Select the captures you want in the Captures tab and choose \"Share as assistant\". Kety builds a single file holding those captures and the search index already built from them, so whoever receives it can start asking questions right away.",
          },
          {
            type: "p",
            text: "You decide what travels:",
          },
          {
            type: "ul",
            items: [
              "Which tags to include - anything you untick stays behind",
              "Whether screenshots and recordings come along, or only the text",
              "Whether captures you flagged as sensitive are included - off by default",
              "Whether captures you hid from your own assistant are included - off by default",
            ],
          },
          {
            type: "p",
            text: "Window titles are left out unless you ask for them, and anything tying the captures to you or to your machine is stripped out of the file.",
          },
          {
            type: "p",
            text: "You can save the file and pass it on however you like - no cloud account needed. If you have connected a storage bucket, you can send a link instead.",
          },
        ],
      },
      {
        title: "Someone shared their knowledge with me - what do I get?",
        blocks: [
          {
            type: "p",
            text: "It becomes its own tab next to \"Me\" in the AI Assistant, and you ask it questions just like your own. Use the + button in that row of tabs to add one, from a file or from a link.",
          },
          {
            type: "p",
            text: "It is read-only: you cannot add to it or change what is inside. You can give it a name of your choosing when you add it, and remove it whenever you want - which deletes its captures, its files and your conversations with it from your computer.",
          },
          {
            type: "p",
            text: "If it was indexed with a search model you do not have, Kety tells you and offers to index it again with one of yours. The text travelled with the file, so nothing is lost - it just needs a moment of work on your machine.",
          },
        ],
      },
      {
        title: "Why would I connect a storage bucket, and do I need one?",
        blocks: [
          {
            type: "p",
            text: "You do not need one. Everything you can share, you can save as a file and send however you prefer.",
          },
          {
            type: "p",
            text: "A bucket adds one thing: handing someone a link instead of a file. Kety has no server of its own, so a link has to live in storage you control - your own Google Cloud Storage bucket.",
          },
          {
            type: "p",
            text: "Setup takes a bucket name plus a service account JSON key from your GCP project, granted the Storage Object Admin role (so it can both upload and delete files - needed for revoking a share link) - a few minutes in the Google Cloud console. Cost is minimal for this kind of usage, and Google Cloud regularly offers free credits for new accounts that comfortably cover it.",
          },
          {
            type: "links",
            items: [
              {
                href: "https://cloud.google.com/storage/docs/access-control/iam-roles",
                label: "https://cloud.google.com/storage/docs/access-control/iam-roles",
              },
            ],
          },
          {
            type: "p",
            text: "It's entirely yours: Kety uploads directly to your bucket and never sees or stores your files anywhere else.",
          },
          { type: "h3", text: "What a bucket adds" },
          {
            type: "ul",
            items: [
              "Sharing a selection of captures as a link that expires on its own, up to 7 days",
              "Sharing a whole assistant as the same kind of link",
              "A history of the links you have created, so you can copy one again or revoke it before it expires",
            ],
          },
          {
            type: "p",
            text: "Set this up under Settings → Sharing.",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "The floating bar",
    sections: [
      {
        title: "What is the small bar that appears on my screen?",
        blocks: [
          {
            type: "p",
            text: "That's Kety's floating bar. It appears when you start dictating or act on selected text, and goes away when it is done. It never shows up on its own.",
          },
          { type: "p", text: "What you can do from it:" },
          {
            type: "ul",
            items: [
              "Dictate into whatever you are writing - tap the Fn (Globe) key, or press ⌘⌥E, and speak. Kety writes the text into the field you were in.",
              "Dictate into your captures - press ⌘⌥D and speak. The text is saved as a capture rather than typed out.",
              "Rework selected text - highlight something, press ⌘⌥T, and pick an action: translate, correct, rephrase, or \"Custom…\" to type a one-off instruction. The result replaces your selection.",
              "Read what came out - the text stays on screen for a few seconds with a copy button, and stops counting down while your pointer is over it.",
              "Ask for changes - when a model produced the text, you can open a short chat from the result and refine it. That chat has its own microphone if you would rather speak than type.",
            ],
          },
          {
            type: "p",
            text: "While you are dictating, the bar shows a timer and a level meter so you can see it is hearing you, with buttons to pause or stop.",
          },
          {
            type: "p",
            text: "You can drag the result and the chat anywhere you like. Change the shortcuts under Settings → Shortcuts, and the list of text actions under Settings → Selection Transform.",
          },
        ],
      },
    ],
  },
  {
    categoryTitle: "Feedback and contributing",
    sections: [
      {
        title: "I want something changed - what can I do?",
        blocks: [
          {
            type: "p",
            text: "Kety is open source, so you have two ways to go about it.",
          },
          {
            type: "p",
            text: "If you are comfortable with code, change it yourself and open a pull request - the whole app is there to read, fork and improve.",
          },
          {
            type: "links",
            items: [
              { href: "https://github.com/sverbo/kety", label: "Kety on GitHub" },
            ],
          },
          {
            type: "prose",
            parts: [
              { text: "Otherwise, just write to " },
              { text: "sam@kety.app", href: "mailto:sam@kety.app" },
              {
                text: " - bugs, ideas, things that annoy you, all welcome.",
              },
            ],
          },
        ],
      },
    ],
  },
];
