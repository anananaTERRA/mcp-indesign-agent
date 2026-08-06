/**
 * MCP InDesign Agent — unique runtime dispatcher (ExtendScript / ES3).
 * Invoked via: do script … with arguments { requestPath, responsePath }
 *
 * Ops: ping | noop | scanDocument | getSelection
 */
#target "InDesign"

var MCP_LABEL_PREFIX = "mcp:";

function mcpReadFile(path) {
  var f = new File(path);
  if (!f.exists) {
    throw new Error("Request file not found: " + path);
  }
  f.encoding = "UTF-8";
  f.open("r");
  var contents = f.read();
  f.close();
  return contents;
}

function mcpWriteFile(path, contents) {
  var f = new File(path);
  f.encoding = "UTF-8";
  f.open("w");
  f.write(contents);
  f.close();
}

function mcpParseJson(text) {
  if (typeof JSON !== "undefined" && JSON.parse) {
    return JSON.parse(text);
  }
  return eval("(" + text + ")");
}

function mcpStringify(value) {
  if (typeof JSON !== "undefined" && JSON.stringify) {
    return JSON.stringify(value);
  }
  return mcpStringifyFallback(value);
}

function mcpStringifyFallback(value) {
  if (value === null) return "null";
  var t = typeof value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "string") {
    return (
      '"' +
      value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t") +
      '"'
    );
  }
  if (value instanceof Array) {
    var parts = [];
    for (var i = 0; i < value.length; i++) {
      parts.push(mcpStringifyFallback(value[i]));
    }
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    var keys = [];
    for (var k in value) {
      if (value.hasOwnProperty(k) && typeof value[k] !== "undefined") {
        keys.push(mcpStringifyFallback(k) + ":" + mcpStringifyFallback(value[k]));
      }
    }
    return "{" + keys.join(",") + "}";
  }
  return "null";
}

function mcpSafePreview(text, maxLen) {
  if (!text) return "";
  var s = String(text).replace(/\s+/g, " ");
  if (s.length > maxLen) {
    return s.substring(0, maxLen);
  }
  return s;
}

function mcpUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    var v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function mcpStripPrefix(label) {
  if (!label) return null;
  var s = String(label);
  if (s.indexOf(MCP_LABEL_PREFIX) === 0) {
    return s.substring(MCP_LABEL_PREFIX.length);
  }
  return null;
}

/**
 * Ensure page item has mcp:<uuid> script label. Returns uuid without prefix.
 */
function mcpEnsureUuid(item) {
  var existing = "";
  try {
    existing = String(item.label || "");
  } catch (e) {
    existing = "";
  }
  var uuid = mcpStripPrefix(existing);
  if (uuid && uuid.length > 0) {
    return uuid;
  }
  uuid = mcpUuid();
  try {
    item.label = MCP_LABEL_PREFIX + uuid;
  } catch (e2) {
    /* locked / non-writable — still expose ephemeral uuid this scan */
  }
  return uuid;
}

function mcpBounds(item) {
  try {
    var b = item.geometricBounds; // [y1, x1, y2, x2]
    return {
      y1: b[0],
      x1: b[1],
      y2: b[2],
      x2: b[3],
    };
  } catch (e) {
    return null;
  }
}

function mcpItemType(item) {
  try {
    if (item instanceof TextFrame) return "TextFrame";
    if (item instanceof Rectangle) return "Rectangle";
    if (item instanceof Oval) return "Oval";
    if (item instanceof GraphicLine) return "GraphicLine";
    if (item instanceof Polygon) return "Polygon";
    if (item instanceof Group) return "Group";
  } catch (e) {
    /* ignore */
  }
  try {
    return String(item.reflect.name);
  } catch (e2) {
    return "PageItem";
  }
}

function mcpDocPath(d) {
  try {
    if (d.saved) {
      return String(d.fullName.fsName);
    }
  } catch (e) {
    /* unsaved or unavailable */
  }
  return null;
}

function mcpTextPreview(item) {
  try {
    if (item.hasOwnProperty("contents")) {
      return mcpSafePreview(item.contents, 120);
    }
  } catch (e) {
    /* ignore */
  }
  try {
    if (item.texts && item.texts.length > 0) {
      return mcpSafePreview(item.texts[0].contents, 120);
    }
  } catch (e2) {
    /* ignore */
  }
  return "";
}

function mcpParagraphStyle(item) {
  try {
    if (item instanceof TextFrame && item.paragraphs && item.paragraphs.length > 0) {
      return String(item.paragraphs[0].appliedParagraphStyle.name);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpFontSize(item) {
  try {
    if (item instanceof TextFrame && item.texts && item.texts.length > 0) {
      return Number(item.texts[0].pointSize);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpLayerName(item) {
  try {
    return String(item.itemLayer.name);
  } catch (e) {
    return null;
  }
}

function mcpParentUuid(item, uuidByItem) {
  try {
    var p = item.parent;
    if (p && p instanceof Group) {
      var key = mcpItemKey(p);
      if (uuidByItem[key]) return uuidByItem[key];
      return mcpEnsureUuid(p);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpItemKey(item) {
  try {
    return String(item.id);
  } catch (e) {
    return String(item);
  }
}

function mcpPageIndexForItem(item, doc) {
  try {
    var p = item.parentPage;
    if (p) {
      for (var i = 0; i < doc.pages.length; i++) {
        if (doc.pages[i] === p) return i;
      }
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpCollectStyleNames(collection) {
  var out = [];
  var i;
  try {
    for (i = 0; i < collection.length; i++) {
      try {
        out.push({ name: String(collection[i].name) });
      } catch (e) {
        /* skip */
      }
    }
  } catch (e2) {
    /* ignore */
  }
  return out;
}

function mcpLinkStatus(link) {
  try {
    return String(link.status);
  } catch (e) {
    return "UNKNOWN";
  }
}

function opPing() {
  var doc = null;
  if (app.documents.length > 0) {
    var d = app.activeDocument;
    doc = {
      name: d.name,
      path: mcpDocPath(d),
      pageCount: d.pages.length,
    };
  }
  return {
    op: "ping",
    appName: String(app.name),
    version: String(app.version),
    locale: String(app.locale),
    document: doc,
  };
}

function opNoop(cmd) {
  return {
    op: "noop",
    echo: cmd && cmd.echo !== undefined ? cmd.echo : null,
  };
}

function opScanDocument(cmd) {
  if (app.documents.length === 0) {
    throw new Error("NO_DOCUMENT: No active InDesign document. Open a .indd first.");
  }

  var depth = (cmd && cmd.depth) || "full";
  var writeUuids = !(cmd && cmd.writeUuids === false);
  var d = app.activeDocument;
  var pageSize = null;
  try {
    var pb = d.documentPreferences;
    pageSize = {
      width: pb.pageWidth,
      height: pb.pageHeight,
    };
  } catch (e) {
    /* ignore */
  }

  var units = null;
  try {
    units = String(d.viewPreferences.horizontalMeasurementUnits);
  } catch (e2) {
    /* ignore */
  }

  var pages = [];
  var items = [];
  var uuidByItem = {};
  var pageLimit = d.pages.length;
  var i;
  var j;

  for (i = 0; i < pageLimit; i++) {
    var page = d.pages[i];
    pages.push({
      index: i,
      name: String(page.name),
    });

    if (depth === "none") {
      continue;
    }

    var pageItems = page.allPageItems;
    // First pass: ensure UUIDs so parent resolution works.
    for (j = 0; j < pageItems.length; j++) {
      var it0 = pageItems[j];
      var uuid0 = writeUuids ? mcpEnsureUuid(it0) : mcpStripPrefix(String(it0.label || "")) || ("tmp-" + j);
      uuidByItem[mcpItemKey(it0)] = uuid0;
    }

    for (j = 0; j < pageItems.length; j++) {
      var it = pageItems[j];
      var uuid = uuidByItem[mcpItemKey(it)];
      var entry = {
        uuid: uuid,
        pageIndex: i,
        itemIndex: j,
        type: mcpItemType(it),
        bounds: mcpBounds(it),
        label: MCP_LABEL_PREFIX + uuid,
        textPreview: "",
        parentUuid: null,
        layerName: null,
        paragraphStyle: null,
        fontSize: null,
      };
      entry.textPreview = mcpTextPreview(it);
      if (depth === "full" || depth === "rich") {
        entry.parentUuid = mcpParentUuid(it, uuidByItem);
        entry.layerName = mcpLayerName(it);
        entry.paragraphStyle = mcpParagraphStyle(it);
        entry.fontSize = mcpFontSize(it);
      }
      items.push(entry);
    }
  }

  var layers = [];
  var styles = { paragraph: [], character: [], object: [] };
  var swatches = [];
  var fonts = [];
  var links = [];
  var masterPages = [];
  var selection = [];

  if (depth === "full" || depth === "rich") {
    try {
      for (i = 0; i < d.layers.length; i++) {
        var layer = d.layers[i];
        layers.push({
          name: String(layer.name),
          visible: !!layer.visible,
          locked: !!layer.locked,
        });
      }
    } catch (eL) {
      /* ignore */
    }

    try {
      styles.paragraph = mcpCollectStyleNames(d.paragraphStyles);
      styles.character = mcpCollectStyleNames(d.characterStyles);
      styles.object = mcpCollectStyleNames(d.objectStyles);
    } catch (eS) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.swatches.length; i++) {
        try {
          swatches.push({
            name: String(d.swatches[i].name),
            colorType: null,
          });
        } catch (eSw) {
          /* skip */
        }
      }
    } catch (eSw2) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.fonts.length; i++) {
        try {
          fonts.push({
            name: String(d.fonts[i].name),
            status: String(d.fonts[i].status),
          });
        } catch (eF) {
          /* skip */
        }
      }
    } catch (eF2) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.links.length; i++) {
        var link = d.links[i];
        var linkPage = null;
        try {
          if (link.parent && link.parent.parentPage) {
            linkPage = mcpPageIndexForItem(link.parent, d);
          }
        } catch (eLp) {
          /* ignore */
        }
        var filePath = null;
        try {
          filePath = String(link.filePath);
        } catch (eFp) {
          /* ignore */
        }
        links.push({
          id: String(link.id),
          name: String(link.name),
          filePath: filePath,
          status: mcpLinkStatus(link),
          pageIndex: linkPage,
        });
      }
    } catch (eLk) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.masterSpreads.length; i++) {
        var ms = d.masterSpreads[i];
        masterPages.push({
          name: String(ms.name),
          index: i,
        });
      }
    } catch (eM) {
      /* ignore */
    }

    selection = mcpReadSelectionUuids(d, writeUuids);
  }

  var uuidList = [];
  for (i = 0; i < items.length; i++) {
    uuidList.push(items[i].uuid);
  }
  uuidList.sort();
  var generation =
    String(mcpDocPath(d) || "unsaved") +
    "|p" +
    d.pages.length +
    "|n" +
    items.length +
    "|" +
    uuidList.join(",").length;

  return {
    op: "scanDocument",
    depth: depth,
    meta: {
      name: d.name,
      path: mcpDocPath(d),
      pageCount: d.pages.length,
      pageSize: pageSize,
      units: units,
      generation: generation,
    },
    pages: pages,
    items: items,
    layers: layers,
    styles: styles,
    swatches: swatches,
    fonts: fonts,
    links: links,
    masterPages: masterPages,
    selection: selection,
  };
}

function mcpReadSelectionUuids(doc, writeUuids) {
  var out = [];
  var i;
  try {
    var sel = app.selection;
    for (i = 0; i < sel.length; i++) {
      var s = sel[i];
      try {
        // Text selection → resolve to parent text frame when possible
        if (s.hasOwnProperty("parentTextFrames")) {
          var tfs = s.parentTextFrames;
          if (tfs && tfs.length > 0) {
            s = tfs[0];
          }
        }
      } catch (eTf) {
        /* ignore */
      }
      try {
        if (s instanceof PageItem || s instanceof TextFrame || s instanceof Group) {
          var u = writeUuids ? mcpEnsureUuid(s) : mcpStripPrefix(String(s.label || ""));
          if (u) out.push(u);
        }
      } catch (eSel) {
        /* skip non-page-items */
      }
    }
  } catch (e) {
    /* ignore */
  }
  return out;
}

function opGetSelection(cmd) {
  if (app.documents.length === 0) {
    throw new Error("NO_DOCUMENT: No active InDesign document. Open a .indd first.");
  }
  var writeUuids = !(cmd && cmd.writeUuids === false);
  var d = app.activeDocument;
  var uuids = mcpReadSelectionUuids(d, writeUuids);
  var items = [];
  var i;
  var sel = app.selection;
  for (i = 0; i < sel.length; i++) {
    var s = sel[i];
    try {
      if (s.hasOwnProperty("parentTextFrames")) {
        var tfs = s.parentTextFrames;
        if (tfs && tfs.length > 0) s = tfs[0];
      }
    } catch (e1) {
      /* ignore */
    }
    try {
      if (!(s instanceof PageItem || s instanceof TextFrame || s instanceof Group)) {
        continue;
      }
      var uuid = writeUuids ? mcpEnsureUuid(s) : mcpStripPrefix(String(s.label || ""));
      if (!uuid) continue;
      items.push({
        uuid: uuid,
        pageIndex: mcpPageIndexForItem(s, d),
        type: mcpItemType(s),
        bounds: mcpBounds(s),
        textPreview: mcpTextPreview(s),
      });
    } catch (e2) {
      /* skip */
    }
  }
  return {
    op: "getSelection",
    selection: uuids,
    items: items,
  };
}

function runCommand(cmd) {
  if (!cmd || !cmd.op) {
    throw new Error("Command missing op");
  }
  switch (String(cmd.op)) {
    case "ping":
      return opPing();
    case "noop":
      return opNoop(cmd);
    case "scanDocument":
      return opScanDocument(cmd);
    case "getSelection":
      return opGetSelection(cmd);
    default:
      throw new Error("Unknown op: " + cmd.op);
  }
}

function mcpMain() {
  var requestPath = arguments[0];
  var responsePath = arguments[1];
  var result;

  try {
    if (!requestPath || !responsePath) {
      throw new Error("dispatcher requires requestPath and responsePath arguments");
    }

    var payload = mcpParseJson(mcpReadFile(requestPath));
    var commands = payload.commands || [];
    var results = [];
    var c;

    // Avoid modal dialogs blocking the bridge.
    var prevInteraction = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel =
      UserInteractionLevels.NEVER_INTERACT;

    try {
      for (c = 0; c < commands.length; c++) {
        results.push(runCommand(commands[c]));
      }
    } finally {
      app.scriptPreferences.userInteractionLevel = prevInteraction;
    }

    result = {
      ok: true,
      requestId: payload.requestId || null,
      results: results,
      modelPatch: null,
    };
  } catch (err) {
    var message = err && err.message ? String(err.message) : String(err);
    result = {
      ok: false,
      requestId: null,
      error: {
        message: message,
        name: err && err.name ? String(err.name) : "Error",
      },
      results: [],
      modelPatch: null,
    };
  }

  try {
    mcpWriteFile(responsePath, mcpStringify(result));
  } catch (writeErr) {
    throw writeErr;
  }
}

mcpMain(arguments[0], arguments[1]);
