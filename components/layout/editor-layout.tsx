"use client";

import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { useEditorState } from "@/lib/editor-state-context";

interface EditorLayoutProps {
  chatPanel: ReactNode;
  editorPanel: ReactNode;
  resourcesPanel: ReactNode;
}

function computeLayout(
  chatVisible: boolean,
  resourcesVisible: boolean,
  sizes: { resources: number; editor: number; chat: number },
): { [panelId: string]: number } {
  const visibleKeys: ("resources" | "editor" | "chat")[] = ["editor"];
  if (chatVisible) visibleKeys.push("chat");
  if (resourcesVisible) visibleKeys.push("resources");

  const visibleTotal = visibleKeys.reduce((sum, k) => sum + sizes[k], 0);

  return {
    chat: chatVisible ? Math.round((sizes.chat / visibleTotal) * 100) : 0,
    editor: Math.round((sizes.editor / visibleTotal) * 100),
    resources: resourcesVisible
      ? Math.round((sizes.resources / visibleTotal) * 100)
      : 0,
  };
}

export default function EditorLayout({
  chatPanel,
  editorPanel,
  resourcesPanel,
}: EditorLayoutProps) {
  const { chatVisible, resourcesVisible, panelSizes, setPanelSizes } = useEditorState();
  const groupRef = useGroupRef();
  const sizesRef = useRef(panelSizes);
  sizesRef.current = panelSizes;

  const hydratedRef = useRef(false);

  useEffect(() => {
    const layout = computeLayout(chatVisible, resourcesVisible, panelSizes);
    groupRef.current?.setLayout(layout);
    requestAnimationFrame(() => {
      hydratedRef.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const layout = computeLayout(chatVisible, resourcesVisible, sizesRef.current);
    groupRef.current?.setLayout(layout);
  }, [chatVisible, resourcesVisible, groupRef]);

  const handleLayoutChanged = useCallback(
    (layout: { [id: string]: number }) => {
      if (!hydratedRef.current) return;

      const chat = layout.chat ?? 0;
      const editor = layout.editor ?? 0;
      const resources = layout.resources ?? 0;

      if (editor < 5) return;

      const chatVis = chat > 1;
      const resVisible = resources > 1;

      let newSizes: { resources: number; editor: number; chat: number };

      if (chatVis && resVisible) {
        newSizes = { chat, editor, resources };
      } else if (chatVis && !resVisible) {
        const storedRes = sizesRef.current.resources;
        const available = 100 - storedRes;
        const chatRatio = chat / (chat + editor);
        newSizes = {
          chat: Math.round(chatRatio * available),
          editor: Math.round((1 - chatRatio) * available),
          resources: storedRes,
        };
      } else if (!chatVis && resVisible) {
        const storedChat = sizesRef.current.chat;
        const available = 100 - storedChat;
        const resRatio = resources / (resources + editor);
        newSizes = {
          chat: storedChat,
          editor: Math.round((1 - resRatio) * available),
          resources: Math.round(resRatio * available),
        };
      } else {
        return;
      }

      setPanelSizes(newSizes);
    },
    [setPanelSizes],
  );

  return (
    <Group
      groupRef={groupRef}
      orientation="horizontal"
      onLayoutChanged={handleLayoutChanged}
      defaultLayout={computeLayout(chatVisible, resourcesVisible, panelSizes)}
      className="flex-1"
    >
      <Panel id="chat" minSize={chatVisible ? 20 : 0} collapsible collapsedSize={0}>
        {chatVisible && <div className="h-full overflow-hidden">{chatPanel}</div>}
      </Panel>

      {chatVisible ? (
        <Separator className="group relative w-px bg-border transition-colors hover:bg-primary/60 data-[active]:bg-primary">
          <div className="absolute inset-y-0 -left-1 -right-1 z-10 group-hover:cursor-col-resize" />
        </Separator>
      ) : (
        <Separator className="w-0" />
      )}

      <Panel id="editor" minSize={30}>
        <div className="h-full overflow-hidden">{editorPanel}</div>
      </Panel>

      {resourcesVisible ? (
        <Separator className="group relative w-px bg-border transition-colors hover:bg-primary/60 data-[active]:bg-primary">
          <div className="absolute inset-y-0 -left-1 -right-1 z-10 group-hover:cursor-col-resize" />
        </Separator>
      ) : (
        <Separator className="w-0" />
      )}

      <Panel id="resources" minSize={resourcesVisible ? 15 : 0} collapsible collapsedSize={0}>
        {resourcesVisible && <div className="h-full overflow-hidden">{resourcesPanel}</div>}
      </Panel>
    </Group>
  );
}
