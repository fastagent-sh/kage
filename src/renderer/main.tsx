import { IconContext } from "@phosphor-icons/react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import Gallery from "./gallery.tsx";
import { Boundary, Button } from "./ui.tsx";
import { Problem } from "./problem.tsx";
import "./index.css";

// Read once: a `[look](#gallery)` link in an answer would otherwise unmount the app mid-run.
const page = window.location.hash === "#gallery" ? <Gallery /> : <App />;

// Phosphor's `regular` is a hairline at 12–16px; `bold` matches SF Symbols' semibold beside text this size.
createRoot(document.getElementById("root")!).render(
  <IconContext.Provider value={{ weight: "bold" }}>
    {/* The last net: a conversation's own boundary (App) catches transcript errors. Runs in main keep going. */}
    <Boundary
      fallback={(error) => (
        <div className="flex h-full">
          <Problem
            layout="page"
            tone="error"
            title="kage could not draw this window"
            advice="Runs keep going in the background. Reload to draw it again; if the conversation it shows is what fails, open a new one instead (that conversation stays in the list)."
            reason={error.message}
            actions={
              <>
                <Button kind="primary" size={32} onClick={() => window.location.reload()}>
                  Reload
                </Button>
                <Button
                  size={32}
                  onClick={() => {
                    // The same fresh start main asks for after repeated crashes (App reads `#fresh` once).
                    window.location.hash = "fresh";
                    window.location.reload();
                  }}
                >
                  Open on a New Conversation
                </Button>
              </>
            }
          />
        </div>
      )}
    >
      {page}
    </Boundary>
  </IconContext.Provider>,
);
