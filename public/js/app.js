// Bootstrap: wire the store to the components and open the socket.
import { initSidebar } from "./ui/sidebar.js";
import { initSidebarResize } from "./ui/sidebar-resize.js";
import { initTerminal, terminalFocusTarget } from "./ui/terminal.js";
import { initHistory } from "./ui/history.js";
import { initTheme } from "./theme.js";
import { initNotify } from "./notify.js";
import { initTitle } from "./title.js";
import { initContentViewer } from "./ui/content-viewer.js";
import { initPrompt } from "./ui/prompt.js";
import { initDrop } from "./ui/drop.js";
import { initVoice } from "./ui/voice.js";
import { initPluginHost } from "./ui/plugin-host.js";
import { initTour } from "./ui/tour.js";
import { connectWs } from "./ws.js";

initSidebar();
initSidebarResize();   // E1: drag handle on the sidebar/terminal divider
initTerminal();
initHistory(terminalFocusTarget);
initTheme();
initNotify();      // register sound/notification listeners BEFORE connect so the config reply is caught
initTitle();       // document.title tracks the active session (§N)
initContentViewer();   // content.show → lightbox (open session) or a clickable toast (other session)
initPrompt();          // R2: prompt.show → question card / annotate modal; prompt.resolved dismisses
initDrop();            // R2: drag a file onto the deck → upload → path pasted into the terminal
initVoice();           // plugin-owned dictation + the bundled Supertonic auto-read control
initPluginHost();      // sandboxed client workers + host-owned actions/viewers/workspaces
initTour();            // first-run walkthrough + unseen feature tips — decides ONCE, on the first config frame
connectWs();
