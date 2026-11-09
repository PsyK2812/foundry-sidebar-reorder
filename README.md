# Sidebar Reorder

A Foundry VTT module (v13–v14) that gives the GM a window for rearranging folders and entries in any sidebar tab: Scenes, Actors, Items, Journal, Roll Tables, Cards, Playlists and Macros.

## Features

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

As GM, open any sidebar tab and click **Reorder** in its header.
From a macro: `game.modules.get("sidebar-reorder").api.open("Scene")` (or `"Actor"`, `"Item"`, `"JournalEntry"`, `"RollTable"`, `"Cards"`, `"Playlist"`, `"Macro"`).

## License

MIT
