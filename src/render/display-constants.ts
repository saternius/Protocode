// Layout constants — must match create-protocode-editor.js
export const RENDER_W = 1500;
export const RENDER_H = 1000;
export const DISPLAY_W = 1.44;
export const DISPLAY_H = 0.96;
export const GUTTER_W = 44;
export const LINE_H = 20;
export const STATUS_H = 0; // Status bar moved to UIX canvas (outside playfield)
export const MAX_VISIBLE_LINES = 48;

export const CODE_AREA_TOP = 480; // (RENDER_H/2) - 20
export const CODE_FONT_SIZE = 0.1625;
export const CHAR_W_APPROX = 10.0;

// File panel
export const FILE_PANEL_W = 280;
export const MAX_FILE_ENTRIES = 40;
export const FILE_AREA_TOP = 460; // (RENDER_H/2) - 40

// Scrollbar
export const SCROLLBAR_W = 14;
export const SCROLLBAR_LEFT_X = 736; // (RENDER_W/2) - SCROLLBAR_W

// Scrollbar track
export const TRACK_TOP = 480;
export const TRACK_BOTTOM = -482;
export const TRACK_H = 962; // TRACK_TOP - TRACK_BOTTOM

// Derived layout positions
export const PANEL_RIGHT_X = -470;   // -(RENDER_W/2) + FILE_PANEL_W
export const PANEL_CENTER_X = -610;  // -(RENDER_W/2) + (FILE_PANEL_W/2)
export const CODE_LEFT_X = -420;     // PANEL_RIGHT_X + GUTTER_W + 6
export const GUTTER_RIGHT_X = -426;  // PANEL_RIGHT_X + GUTTER_W
export const LINE_HIGH_W = 1162;     // RENDER_W - FILE_PANEL_W - GUTTER_W - SCROLLBAR_W
export const LINE_HIGH_CENTER_X = 155; // PANEL_RIGHT_X + GUTTER_W + (LINE_HIGH_W/2)
