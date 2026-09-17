import { useState, useRef, useMemo } from "react";
import type { ConversationEntry } from "./assistantChatTypes";
import {
  IconEditDoc,
  IconDownload,
  IconPencil,
  IconX,
  IconChevronLeft,
  IconChevronRight,
} from "./AppIcons";

export function DeleteConversationModal({
  conversationName,
  onConfirm,
  onCancel,
}: {
  conversationName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Delete conversation?</h3>
        <p className="modal-body">
          <strong>"{conversationName}"</strong> will be permanently deleted. This cannot be undone.
        </p>
        <div className="modal-actions">
          <button type="button" className="modal-btn modal-btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="modal-btn modal-btn--delete" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConversationSidebar({
  conversations,
  activeIdx,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onDownload,
  collapsed,
  onToggle,
}: {
  conversations: ConversationEntry[];
  activeIdx: number;
  onSelect: (idx: number) => void;
  onNew: () => void;
  onDelete: (idx: number) => void;
  onRename: (idx: number, name: string) => void;
  onDownload: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const filteredConversations = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return conversations
      .map((conv, idx) => ({ conv, idx }))
      .filter(({ conv }) => conv.name.toLowerCase().includes(normalizedQuery));
  }, [conversations, searchQuery]);

  function startEditing(idx: number, currentName: string, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingIdx(idx);
    setEditValue(currentName === "Untitled" ? "" : currentName);
    // Focus the input on the next paint
    requestAnimationFrame(() => editInputRef.current?.select());
  }

  function commitEdit() {
    if (editingIdx === null) return;
    const trimmed = editValue.trim();
    onRename(editingIdx, trimmed || "Untitled");
    setEditingIdx(null);
  }

  function cancelEdit() {
    setEditingIdx(null);
  }

  return (
    <div className={`conv-sidebar${collapsed ? " conv-sidebar--collapsed" : ""}`}>
      <div className="conv-sidebar-header">
        <button
          type="button"
          className="conv-new-btn"
          onClick={onNew}
          title="New conversation"
          aria-label="New conversation"
        >
          <IconEditDoc />
        </button>
        {!collapsed && (
          <span className="conv-sidebar-title">Conversations</span>
        )}
        {!collapsed && (
          <button
            type="button"
            className="conv-download-btn"
            onClick={onDownload}
            title="Download all conversations as JSON"
            aria-label="Download conversations"
          >
            <IconDownload />
          </button>
        )}
      </div>
      <div className="conv-sidebar-body">
        {!collapsed && (
          <div className="conv-sidebar-list">
            {[...filteredConversations].sort((a, b) => b.idx - a.idx).map(({ conv, idx: conversationIdx }) => (
              <div
                key={conv.clientId}
                className={`conv-item-wrap${conversationIdx === activeIdx ? " conv-item-wrap--active" : ""}${editingIdx === conversationIdx ? " conv-item-wrap--editing" : ""}`}
              >
                {editingIdx === conversationIdx ? (
                  <input
                    ref={editInputRef}
                    className="conv-name-input"
                    value={editValue}
                    placeholder="Untitled"
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
                      if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                    }}
                    autoFocus
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="conv-item"
                      onClick={() => onSelect(conversationIdx)}
                      onDoubleClick={(e) => startEditing(conversationIdx, conv.name, e)}
                      title={conv.name}
                    >
                      <span className="conv-item-name">{conv.name}</span>
                    </button>
                    <button
                      type="button"
                      className="conv-rename-btn"
                      onClick={(e) => startEditing(conversationIdx, conv.name, e)}
                      title="Rename conversation"
                      aria-label="Rename conversation"
                    >
                      <IconPencil />
                    </button>
                    <button
                      type="button"
                      className="conv-delete-btn"
                      onClick={(e) => { e.stopPropagation(); onDelete(conversationIdx); }}
                      title="Delete conversation"
                      aria-label="Delete conversation"
                    >
                      <IconX />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="conv-sidebar-search-wrap">
          <input
            type="text"
            className="conv-sidebar-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search title..."
            aria-label="Search conversations by title"
          />
        </div>
      )}
      <div className="conv-sidebar-footer">
        <button
          type="button"
          className="conv-collapse-btn"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
        </button>
      </div>
    </div>
  );
}
