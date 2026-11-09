# Sidebar Reorder

A Foundry VTT module (v13–v14) that gives the GM a window for rearranging folders and entries in any sidebar tab: Scenes, Actors, Items, Journal, Roll Tables, Cards, Playlists and Macros.

## Up/down controls in the sidebar

Hover any folder or entry (as GM) and you get three controls on the right:

- **▲ / ▼** move it one step within its folder. **Shift-click** sends it to the top / bottom
- **Grip** (≡): hold and slide up or down; an orange line shows where it will land; Esc cancels
- Works at the top level and inside folders, including folders sorted A–Z (they switch to manual order so the move sticks)
- Each move saves immediately. **Alt+Z** undoes the last one (rebindable under Configure Controls)
- To move something into a *different* folder, use Foundry's normal drag & drop
- Turn off per user under **Module Settings → Up/down buttons in the sidebar**

## Reorder window (optional)

Hidden by default. Turn on **Module Settings → Show Reorder button** to get a button in each tab that opens it.

- Full folder tree of the tab in one window, in the same order the sidebar shows
- **Drag and drop**: drop above or below a row to reorder, or on the middle of a folder to put the item inside it (works for subfolders too)
- **Arrow buttons** on every row: move to top, up, down, to bottom
- **A–Z button** per folder (and for the top level): sorts it alphabetically and keeps it that way, so new items land in name order
- Badge on each folder showing whether it's in A–Z or manual order. Moving something by hand switches it to manual automatically
- Changed rows are marked. **Nothing is written until you click Save**, and everything is saved in one batch
- **Discard** throws away unsaved changes; **Undo last save** puts back the previous order
- Blocks invalid moves (a folder into its own subfolder, or nesting deeper than Foundry allows)
- Expand/collapse all; folder colours match the sidebar

## Install

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/PsyK2812/foundry-sidebar-reorder/releases/latest/download/module.json
```

## Usage

As GM, hover a row in any sidebar tab and use the arrows or the grip. For the window, enable the button or use the macro below.
From a macro: `game.modules.get("sidebar-reorder").api.open("Scene")` (or `"Actor"`, `"Item"`, `"JournalEntry"`, `"RollTable"`, `"Cards"`, `"Playlist"`, `"Macro"`).

## License

MIT
