/**
 * MCP InDesign Agent — unique runtime dispatcher (ExtendScript / ES3).
 * Invoked via: do script … with arguments { requestPath, responsePath }
 *
 * Ops: ping | noop | scanDocument | getSelection | checkpoint
 *      moveItem | resizeItem | deleteItem | duplicateItem | createTextFrame
 *      setText | replaceText | setFont | setFill
 *      alignItems | distributeItems | centerItems | stackItems | applyMargins
 *      listStyles | applyStyle | createStyle | updateStyle
 *      listAssets | checkMissingLinks | relinkAsset | embedAsset
 *
 * Every request that contains a mutating op runs inside a single
 * UndoModes.ENTIRE_SCRIPT transaction, so one Cmd+Z undoes the whole request
 * and a throw halfway through leaves the document untouched. `checkpoint` runs
 * before that transaction and outside it: the safety copy has to survive the
 * rollback it exists for.
 *
 * Names that come from caller input (transaction label, checkpoint tag) are
 * forced to ASCII: JSX carrying non-ASCII through osascript has failed
 * silently in practice, and checkpoint tags end up in filenames.
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
        .replace(/\t/g, "\\t")
        // InDesign special characters (page number, section marker, indent-to-here...) are < 0x20
        .replace(/[\x00-\x1f\u2028\u2029]/g, function (c) {
          return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) +
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

/** Math.imul for ES3: 32-bit multiply without losing the high bits to floats. */
function mcpImul(a, b) {
  var ah = (a >>> 16) & 0xffff;
  var al = a & 0xffff;
  var bh = (b >>> 16) & 0xffff;
  var bl = b & 0xffff;
  return (al * bl + ((((ah * bl + al * bh) << 16) >>> 0) | 0)) | 0;
}

/** FNV-1a, mirrored in src/session/document-model.ts. */
function mcpHash32(s) {
  var h = 2166136261;
  var i;
  for (i = 0; i < s.length; i++) {
    h = h ^ s.charCodeAt(i);
    h = mcpImul(h, 16777619);
  }
  return (h >>> 0).toString(16);
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
    // Prefer symbolic names over raw enum integers when possible.
    var st = link.status;
    if (st === LinkStatus.NORMAL) return "NORMAL";
    if (st === LinkStatus.LINK_MISSING) return "LINK_MISSING";
    if (st === LinkStatus.LINK_OUT_OF_DATE) return "LINK_OUT_OF_DATE";
    if (st === LinkStatus.LINK_EMBEDDED) return "LINK_EMBEDDED";
    if (st === LinkStatus.LINK_INACCESSIBLE) return "LINK_INACCESSIBLE";
    return String(st);
  } catch (e) {
    return "UNKNOWN";
  }
}

function mcpCollectLinks(doc) {
  var links = [];
  var i;
  try {
    for (i = 0; i < doc.links.length; i++) {
      var link = doc.links[i];
      var linkPage = null;
      try {
        if (link.parent && link.parent.parentPage) {
          linkPage = mcpPageIndexForItem(link.parent, doc);
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
  return links;
}

function mcpCollectAllStyles(doc) {
  return {
    paragraph: mcpCollectStyleNames(doc.paragraphStyles),
    character: mcpCollectStyleNames(doc.characterStyles),
    object: mcpCollectStyleNames(doc.objectStyles),
  };
}

function mcpFindStyle(doc, styleKind, name) {
  var kind = String(styleKind || "paragraph");
  var n = String(name);
  var style;
  try {
    if (kind === "character") {
      style = doc.characterStyles.itemByName(n);
    } else if (kind === "object") {
      style = doc.objectStyles.itemByName(n);
    } else {
      style = doc.paragraphStyles.itemByName(n);
    }
    if (!style || !style.isValid) {
      throw new Error("missing");
    }
    return style;
  } catch (e) {
    throw new Error("Style not found (" + kind + "): " + n);
  }
}

function mcpGetTextForItem(item) {
  if (item instanceof TextFrame && item.texts.length > 0) return item.texts[0];
  if (item.texts && item.texts.length > 0) return item.texts[0];
  throw new Error("Item has no text");
}

function mcpFindLink(doc, linkId, name) {
  var i;
  var idStr = linkId !== undefined && linkId !== null ? String(linkId) : null;
  var nameStr = name !== undefined && name !== null ? String(name) : null;
  for (i = 0; i < doc.links.length; i++) {
    var link = doc.links[i];
    try {
      if (idStr && String(link.id) === idStr) return link;
      if (nameStr && String(link.name) === nameStr) return link;
    } catch (e) {
      /* skip */
    }
  }
  throw new Error(
    "Link not found" +
      (idStr ? " id=" + idStr : "") +
      (nameStr ? " name=" + nameStr : ""),
  );
}

function mcpPatchStyles(doc) {
  gModelPatch.styles = mcpCollectAllStyles(doc);
}

function mcpPatchLinks(doc) {
  gModelPatch.links = mcpCollectLinks(doc);
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
      styles = mcpCollectAllStyles(d);
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
      links = mcpCollectLinks(d);
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
  // Same recipe as buildGeneration() in src/session/document-model.ts so a
  // generation computed here and one computed after a modelPatch compare equal.
  var generation =
    String(mcpDocPath(d) || "unsaved") +
    "|p" +
    d.pages.length +
    "|n" +
    items.length +
    "|" +
    mcpHash32(uuidList.join(","));

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

/* --- checkpoint: the only real undo net (runs outside the transaction) --- */

function mcpPad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function mcpStamp(d) {
  return (
    d.getFullYear() +
    mcpPad2(d.getMonth() + 1) +
    mcpPad2(d.getDate()) +
    "-" +
    mcpPad2(d.getHours()) +
    mcpPad2(d.getMinutes()) +
    mcpPad2(d.getSeconds())
  );
}

function mcpPruneCheckpoints(cpFolder, base, keep) {
  var pruned = [];
  try {
    var all = cpFolder.getFiles(function (f) {
      if (!(f instanceof File)) return false;
      var n = String(decodeURI(f.name));
      return n.indexOf(base + "-") === 0 && /\.indd$/i.test(n);
    });
    if (all.length <= keep) return pruned;
    all.sort(function (a, b) {
      return a.modified - b.modified;
    });
    var i;
    for (i = 0; i < all.length - keep; i++) {
      var victim = all[i].fsName;
      try {
        if (all[i].remove()) pruned.push(victim);
      } catch (eRm) {
        /* a locked/open copy is not worth failing the checkpoint over */
      }
    }
  } catch (eP) {
    /* pruning is housekeeping; never let it sink the checkpoint */
  }
  return pruned;
}

/**
 * saveACopy of the live document (unsaved edits included) into
 * <doc folder>/_checkpoints/<base>-<tag>-<YYYYMMDD-HHMMSS>.indd
 */
function opCheckpoint(cmd) {
  var doc = mcpRequireDoc();

  var folder = null;
  try {
    folder = doc.filePath;
  } catch (eFp) {
    folder = null;
  }
  if (!folder) {
    throw new Error(
      "CHECKPOINT_FAILED: document has never been saved, so there is no folder to copy it into. Save the .indd once, then retry.",
    );
  }

  var cpFolder = new Folder(folder.fsName + "/_checkpoints");
  if (!cpFolder.exists && !cpFolder.create()) {
    throw new Error("CHECKPOINT_FAILED: could not create " + cpFolder.fsName);
  }

  var base = String(doc.name).replace(/\.indd$/i, "");
  var tag = String(cmd.tag || "batch").replace(/[^A-Za-z0-9_-]/g, "-");
  var out = new File(
    cpFolder.fsName + "/" + base + "-" + tag + "-" + mcpStamp(new Date()) + ".indd",
  );

  try {
    doc.saveACopy(out);
  } catch (eSave) {
    throw new Error(
      "CHECKPOINT_FAILED: saveACopy to " +
        out.fsName +
        " failed (" +
        (eSave && eSave.message ? eSave.message : eSave) +
        ")",
    );
  }
  if (!out.exists) {
    throw new Error(
      "CHECKPOINT_FAILED: saveACopy reported success but " +
        out.fsName +
        " is not on disk",
    );
  }

  var keep =
    cmd.keep !== undefined && cmd.keep !== null ? Number(cmd.keep) : 12;
  if (!(keep > 0)) keep = 12;

  var bytes = null;
  try {
    bytes = Number(out.length);
  } catch (eLen) {
    bytes = null;
  }

  return {
    op: "checkpoint",
    path: out.fsName,
    folder: cpFolder.fsName,
    tag: tag,
    keep: keep,
    bytes: bytes,
    pruned: mcpPruneCheckpoints(cpFolder, base, keep),
    documentName: String(doc.name),
    documentPath: mcpDocPath(doc),
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

/* ─── Mutations (phase 3+) — coordinates in POINTS ─── */

var gModelPatch = { updated: [], removed: [], styles: null, links: null };

function mcpRequireDoc() {
  if (app.documents.length === 0) {
    throw new Error("NO_DOCUMENT: No active InDesign document. Open a .indd first.");
  }
  return app.activeDocument;
}

function mcpFindByUuid(doc, uuid) {
  var label = MCP_LABEL_PREFIX + String(uuid);
  var i;
  var j;
  for (i = 0; i < doc.pages.length; i++) {
    var pageItems = doc.pages[i].allPageItems;
    for (j = 0; j < pageItems.length; j++) {
      try {
        if (String(pageItems[j].label || "") === label) {
          return pageItems[j];
        }
      } catch (e) {
        /* skip */
      }
    }
  }
  throw new Error("ITEM_NOT_FOUND: No page item with uuid " + uuid);
}

function mcpSerializeItem(item, doc) {
  var uuid = mcpEnsureUuid(item);
  return {
    uuid: uuid,
    pageIndex: mcpPageIndexForItem(item, doc),
    itemIndex: 0,
    type: mcpItemType(item),
    bounds: mcpBounds(item),
    textPreview: mcpTextPreview(item),
    parentUuid: null,
    layerName: mcpLayerName(item),
    paragraphStyle: mcpParagraphStyle(item),
    fontSize: mcpFontSize(item),
  };
}

function mcpPatchUpdated(item, doc) {
  gModelPatch.updated.push(mcpSerializeItem(item, doc));
}

function mcpPatchRemoved(uuid) {
  gModelPatch.removed.push(String(uuid));
}

function mcpSetBounds(item, y1, x1, y2, x2) {
  item.geometricBounds = [y1, x1, y2, x2];
}

function opMoveItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var b = item.geometricBounds;
  var y1 = b[0];
  var x1 = b[1];
  var y2 = b[2];
  var x2 = b[3];
  var w = x2 - x1;
  var h = y2 - y1;

  if (cmd.x !== undefined && cmd.x !== null) {
    x1 = Number(cmd.x);
    x2 = x1 + w;
  } else if (cmd.dx !== undefined && cmd.dx !== null) {
    x1 += Number(cmd.dx);
    x2 += Number(cmd.dx);
  }
  if (cmd.y !== undefined && cmd.y !== null) {
    y1 = Number(cmd.y);
    y2 = y1 + h;
  } else if (cmd.dy !== undefined && cmd.dy !== null) {
    y1 += Number(cmd.dy);
    y2 += Number(cmd.dy);
  }

  mcpSetBounds(item, y1, x1, y2, x2);
  mcpPatchUpdated(item, doc);
  return { op: "moveItem", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opResizeItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var b = item.geometricBounds;
  var y1 = b[0];
  var x1 = b[1];
  var y2 = b[2];
  var x2 = b[3];
  var w = x2 - x1;
  var h = y2 - y1;
  if (cmd.width !== undefined && cmd.width !== null) w = Number(cmd.width);
  if (cmd.height !== undefined && cmd.height !== null) h = Number(cmd.height);
  mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
  mcpPatchUpdated(item, doc);
  return { op: "resizeItem", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opDeleteItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  item.remove();
  mcpPatchRemoved(cmd.target);
  return { op: "deleteItem", target: cmd.target, removed: String(cmd.target) };
}

function opDuplicateItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var dup = item.duplicate();
  var uuid = mcpUuid();
  try {
    dup.label = MCP_LABEL_PREFIX + uuid;
  } catch (e) {
    /* ignore */
  }
  var dx = cmd.dx !== undefined && cmd.dx !== null ? Number(cmd.dx) : 12;
  var dy = cmd.dy !== undefined && cmd.dy !== null ? Number(cmd.dy) : 12;
  var b = dup.geometricBounds;
  mcpSetBounds(dup, b[0] + dy, b[1] + dx, b[2] + dy, b[3] + dx);
  mcpPatchUpdated(dup, doc);
  return {
    op: "duplicateItem",
    target: cmd.target,
    created: mcpSerializeItem(dup, doc),
  };
}

/**
 * Create a new text frame on a page.
 * Absolute: x, y, width, height (points).
 * Or relative: belowTarget uuid + gapPt (inherits x/width from anchor when omitted).
 */
function opCreateTextFrame(cmd) {
  var doc = mcpRequireDoc();
  var pageIndex =
    cmd.pageIndex !== undefined && cmd.pageIndex !== null
      ? Number(cmd.pageIndex)
      : 0;
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(
      "createTextFrame pageIndex out of range (0.." +
        (doc.pages.length - 1) +
        ")",
    );
  }
  var page = doc.pages[pageIndex];

  var x;
  var y;
  var width;
  var height;
  var gap =
    cmd.gapPt !== undefined && cmd.gapPt !== null ? Number(cmd.gapPt) : 12;

  if (cmd.belowTarget) {
    var anchor = mcpFindByUuid(doc, cmd.belowTarget);
    var ab = anchor.geometricBounds; // y1,x1,y2,x2
    x = cmd.x !== undefined && cmd.x !== null ? Number(cmd.x) : ab[1];
    width =
      cmd.width !== undefined && cmd.width !== null
        ? Number(cmd.width)
        : ab[3] - ab[1];
    height =
      cmd.height !== undefined && cmd.height !== null
        ? Number(cmd.height)
        : Math.max(36, (ab[2] - ab[0]) * 1.5);
    y = cmd.y !== undefined && cmd.y !== null ? Number(cmd.y) : ab[2] + gap;
    try {
      var ap = mcpPageIndexForItem(anchor, doc);
      if (ap !== null && ap !== undefined) pageIndex = ap;
      page = doc.pages[pageIndex];
    } catch (eP) {
      /* keep pageIndex */
    }
  } else {
    if (
      cmd.x === undefined ||
      cmd.y === undefined ||
      cmd.width === undefined ||
      cmd.height === undefined
    ) {
      throw new Error(
        "createTextFrame requires x,y,width,height — or belowTarget (+ optional gapPt)",
      );
    }
    x = Number(cmd.x);
    y = Number(cmd.y);
    width = Number(cmd.width);
    height = Number(cmd.height);
  }

  if (!(width > 0) || !(height > 0)) {
    throw new Error("createTextFrame width/height must be positive");
  }

  var frame;
  try {
    frame = page.textFrames.add({
      geometricBounds: [y, x, y + height, x + width],
    });
  } catch (eAdd) {
    throw new Error("createTextFrame failed: " + (eAdd.message || eAdd));
  }

  var uuid = mcpUuid();
  try {
    frame.label = MCP_LABEL_PREFIX + uuid;
  } catch (eL) {
    /* ignore */
  }

  if (cmd.text !== undefined && cmd.text !== null) {
    try {
      frame.contents = String(cmd.text);
    } catch (eT) {
      throw new Error("createTextFrame set text failed: " + (eT.message || eT));
    }
  }

  if (cmd.style) {
    try {
      var pStyle = mcpFindStyle(doc, "paragraph", String(cmd.style));
      if (frame.texts && frame.texts.length > 0) {
        frame.texts[0].appliedParagraphStyle = pStyle;
      }
    } catch (eS) {
      throw new Error(
        "createTextFrame style failed: " + (eS.message || eS),
      );
    }
  }

  if (
    cmd.fontSizePt !== undefined &&
    cmd.fontSizePt !== null &&
    frame.texts &&
    frame.texts.length > 0
  ) {
    try {
      frame.texts[0].pointSize = Number(cmd.fontSizePt);
    } catch (eF) {
      /* optional */
    }
  }

  if (cmd.fontFamily && frame.texts && frame.texts.length > 0) {
    try {
      if (cmd.fontStyle) {
        frame.texts[0].appliedFont =
          String(cmd.fontFamily) + "\t" + String(cmd.fontStyle);
      } else {
        frame.texts[0].appliedFont = String(cmd.fontFamily);
      }
    } catch (eFont) {
      /* optional */
    }
  }

  mcpPatchUpdated(frame, doc);
  return {
    op: "createTextFrame",
    created: mcpSerializeItem(frame, doc),
  };
}

function opSetText(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  try {
    if (item instanceof TextFrame) {
      item.contents = String(cmd.text);
    } else if (item.texts && item.texts.length > 0) {
      item.texts[0].contents = String(cmd.text);
    } else {
      throw new Error("Item is not a text frame");
    }
  } catch (e) {
    throw new Error("setText failed: " + (e.message || e));
  }
  mcpPatchUpdated(item, doc);
  return { op: "setText", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opReplaceText(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var find = String(cmd.find);
  var replace = String(cmd.replace);
  var matchCase = !!cmd.matchCase;
  var contents = "";
  try {
    if (item instanceof TextFrame) contents = String(item.contents);
    else if (item.texts && item.texts.length > 0) contents = String(item.texts[0].contents);
    else throw new Error("Item is not a text frame");
  } catch (e) {
    throw new Error("replaceText read failed: " + (e.message || e));
  }

  var next;
  if (matchCase) {
    next = contents.split(find).join(replace);
  } else {
    var re = new RegExp(find.replace(/([.*+?^${}()|[\]\\])/g, "\\$1"), "gi");
    next = contents.replace(re, replace);
  }

  try {
    if (item instanceof TextFrame) item.contents = next;
    else item.texts[0].contents = next;
  } catch (e2) {
    throw new Error("replaceText write failed: " + (e2.message || e2));
  }
  mcpPatchUpdated(item, doc);
  return { op: "replaceText", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opSetFont(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var text;
  try {
    if (item instanceof TextFrame && item.texts.length > 0) text = item.texts[0];
    else if (item.texts && item.texts.length > 0) text = item.texts[0];
    else throw new Error("Item has no text");
  } catch (e) {
    throw new Error("setFont: " + (e.message || e));
  }

  if (cmd.fontFamily) {
    try {
      if (cmd.fontStyle) {
        text.appliedFont = String(cmd.fontFamily) + "\t" + String(cmd.fontStyle);
      } else {
        text.appliedFont = String(cmd.fontFamily);
      }
    } catch (eF) {
      throw new Error("setFont fontFamily failed: " + (eF.message || eF));
    }
  }
  if (cmd.fontSizePt !== undefined && cmd.fontSizePt !== null) {
    text.pointSize = Number(cmd.fontSizePt);
  }
  mcpPatchUpdated(item, doc);
  return { op: "setFont", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function mcpResolveFill(doc, fill) {
  if (!fill) throw new Error("setFill requires fill");
  if (fill.swatch) {
    try {
      return doc.swatches.itemByName(String(fill.swatch));
    } catch (e) {
      throw new Error("Swatch not found: " + fill.swatch);
    }
  }
  var name;
  var color;
  if (fill.rgb) {
    name = "mcp-rgb-" + fill.rgb[0] + "-" + fill.rgb[1] + "-" + fill.rgb[2];
    try {
      color = doc.colors.itemByName(name);
      if (!color.isValid) throw new Error("missing");
      return color;
    } catch (e2) {
      color = doc.colors.add({
        name: name,
        model: ColorModel.PROCESS,
        space: ColorSpace.RGB,
        colorValue: [Number(fill.rgb[0]), Number(fill.rgb[1]), Number(fill.rgb[2])],
      });
      return color;
    }
  }
  if (fill.cmyk) {
    name =
      "mcp-cmyk-" +
      fill.cmyk[0] +
      "-" +
      fill.cmyk[1] +
      "-" +
      fill.cmyk[2] +
      "-" +
      fill.cmyk[3];
    try {
      color = doc.colors.itemByName(name);
      if (!color.isValid) throw new Error("missing");
      return color;
    } catch (e3) {
      color = doc.colors.add({
        name: name,
        model: ColorModel.PROCESS,
        space: ColorSpace.CMYK,
        colorValue: [
          Number(fill.cmyk[0]),
          Number(fill.cmyk[1]),
          Number(fill.cmyk[2]),
          Number(fill.cmyk[3]),
        ],
      });
      return color;
    }
  }
  throw new Error("Unsupported fill spec");
}

function opSetFill(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var color = mcpResolveFill(doc, cmd.fill);
  try {
    item.fillColor = color;
  } catch (e) {
    throw new Error("setFill failed: " + (e.message || e));
  }
  mcpPatchUpdated(item, doc);
  return { op: "setFill", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function mcpCollectTargets(doc, targets) {
  var items = [];
  var i;
  for (i = 0; i < targets.length; i++) {
    items.push(mcpFindByUuid(doc, targets[i]));
  }
  return items;
}

function mcpPageSizePts(doc) {
  return {
    width: Number(doc.documentPreferences.pageWidth),
    height: Number(doc.documentPreferences.pageHeight),
  };
}

function opAlignItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var page = mcpPageSizePts(doc);
  var align = String(cmd.align || "left");
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var item = items[i];
    var b = item.geometricBounds;
    var y1 = b[0];
    var x1 = b[1];
    var y2 = b[2];
    var x2 = b[3];
    var w = x2 - x1;
    var h = y2 - y1;
    if (align === "left") x1 = 0;
    else if (align === "center") x1 = (page.width - w) / 2;
    else if (align === "right") x1 = page.width - w;
    else if (align === "top") y1 = 0;
    else if (align === "middle") y1 = (page.height - h) / 2;
    else if (align === "bottom") y1 = page.height - h;
    mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
    mcpPatchUpdated(item, doc);
    out.push(mcpSerializeItem(item, doc));
  }
  return { op: "alignItems", align: align, items: out };
}

function opDistributeItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  if (items.length < 2) {
    return { op: "distributeItems", items: [], note: "need ≥2 items" };
  }
  var axis = String(cmd.axis || "vertical");
  var entries = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var b = items[i].geometricBounds;
    entries.push({
      item: items[i],
      y1: b[0],
      x1: b[1],
      y2: b[2],
      x2: b[3],
      w: b[3] - b[1],
      h: b[2] - b[0],
    });
  }
  entries.sort(function (a, c) {
    return axis === "horizontal" ? a.x1 - c.x1 : a.y1 - c.y1;
  });

  var first = entries[0];
  var last = entries[entries.length - 1];
  var totalSize = 0;
  for (i = 0; i < entries.length; i++) {
    totalSize += axis === "horizontal" ? entries[i].w : entries[i].h;
  }
  var span =
    axis === "horizontal"
      ? last.x1 + last.w - first.x1 - totalSize
      : last.y1 + last.h - first.y1 - totalSize;
  var gap = span / (entries.length - 1);
  var cursor = axis === "horizontal" ? first.x1 : first.y1;
  var out = [];

  for (i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (axis === "horizontal") {
      mcpSetBounds(e.item, e.y1, cursor, e.y1 + e.h, cursor + e.w);
      cursor += e.w + gap;
    } else {
      mcpSetBounds(e.item, cursor, e.x1, cursor + e.h, e.x1 + e.w);
      cursor += e.h + gap;
    }
    mcpPatchUpdated(e.item, doc);
    out.push(mcpSerializeItem(e.item, doc));
  }
  return { op: "distributeItems", axis: axis, items: out };
}

function opCenterItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var page = mcpPageSizePts(doc);
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var item = items[i];
    var b = item.geometricBounds;
    var w = b[3] - b[1];
    var h = b[2] - b[0];
    var x1 = (page.width - w) / 2;
    var y1 = (page.height - h) / 2;
    mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
    mcpPatchUpdated(item, doc);
    out.push(mcpSerializeItem(item, doc));
  }
  return { op: "centerItems", items: out };
}

function opStackItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var axis = String(cmd.axis || "vertical");
  var gap = cmd.gapPt !== undefined && cmd.gapPt !== null ? Number(cmd.gapPt) : 16;
  var entries = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var b = items[i].geometricBounds;
    entries.push({
      item: items[i],
      y1: b[0],
      x1: b[1],
      w: b[3] - b[1],
      h: b[2] - b[0],
    });
  }
  entries.sort(function (a, c) {
    return axis === "horizontal" ? a.x1 - c.x1 : a.y1 - c.y1;
  });
  var cursor =
    cmd.startPt !== undefined && cmd.startPt !== null
      ? Number(cmd.startPt)
      : axis === "horizontal"
        ? entries[0].x1
        : entries[0].y1;
  var out = [];
  for (i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (axis === "horizontal") {
      mcpSetBounds(e.item, e.y1, cursor, e.y1 + e.h, cursor + e.w);
      cursor += e.w + gap;
    } else {
      mcpSetBounds(e.item, cursor, e.x1, cursor + e.h, e.x1 + e.w);
      cursor += e.h + gap;
    }
    mcpPatchUpdated(e.item, doc);
    out.push(mcpSerializeItem(e.item, doc));
  }
  return { op: "stackItems", axis: axis, gapPt: gap, items: out };
}

function opApplyMargins(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var page = mcpPageSizePts(doc);
  var margin = cmd.marginPt !== undefined && cmd.marginPt !== null ? Number(cmd.marginPt) : 24;
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var item = items[i];
    var b = item.geometricBounds;
    var w = b[3] - b[1];
    var h = b[2] - b[0];
    var maxW = Math.max(1, page.width - 2 * margin);
    var maxH = Math.max(1, page.height - 2 * margin);
    if (w > maxW) w = maxW;
    if (h > maxH) h = maxH;
    var x1 = b[1];
    var y1 = b[0];
    if (x1 < margin) x1 = margin;
    if (y1 < margin) y1 = margin;
    if (x1 + w > page.width - margin) x1 = page.width - margin - w;
    if (y1 + h > page.height - margin) y1 = page.height - margin - h;
    mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
    mcpPatchUpdated(item, doc);
    out.push(mcpSerializeItem(item, doc));
  }
  return { op: "applyMargins", marginPt: margin, items: out };
}

/* ─── Styles + Assets (phase 4) ─── */

function opListStyles(cmd) {
  var doc = mcpRequireDoc();
  var styles = mcpCollectAllStyles(doc);
  var kind = cmd && cmd.styleKind ? String(cmd.styleKind) : null;
  var out = styles;
  if (kind === "paragraph" || kind === "character" || kind === "object") {
    out = {};
    out[kind] = styles[kind];
  }
  return { op: "listStyles", styles: out };
}

function opApplyStyle(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var styleKind = String(cmd.styleKind || "paragraph");
  var styleName = String(cmd.style);
  var style = mcpFindStyle(doc, styleKind, styleName);

  try {
    if (styleKind === "object") {
      item.appliedObjectStyle = style;
    } else {
      var text = mcpGetTextForItem(item);
      if (styleKind === "character") {
        text.appliedCharacterStyle = style;
      } else {
        text.appliedParagraphStyle = style;
      }
    }
  } catch (e) {
    throw new Error("applyStyle failed: " + (e.message || e));
  }

  mcpPatchUpdated(item, doc);
  return {
    op: "applyStyle",
    target: cmd.target,
    styleKind: styleKind,
    style: styleName,
    item: mcpSerializeItem(item, doc),
  };
}

function mcpApplyStyleSpec(style, styleKind, spec) {
  if (!spec) return;
  if (styleKind === "object") {
    // Object styles: limited MVP — fill via fillColor if present on style
    return;
  }
  if (spec.fontFamily) {
    try {
      if (spec.fontStyle) {
        style.appliedFont =
          String(spec.fontFamily) + "\t" + String(spec.fontStyle);
      } else {
        style.appliedFont = String(spec.fontFamily);
      }
    } catch (eF) {
      throw new Error("style fontFamily failed: " + (eF.message || eF));
    }
  }
  if (spec.fontSizePt !== undefined && spec.fontSizePt !== null) {
    try {
      style.pointSize = Number(spec.fontSizePt);
    } catch (eS) {
      throw new Error("style fontSizePt failed: " + (eS.message || eS));
    }
  }
  if (spec.leadingPt !== undefined && spec.leadingPt !== null) {
    try {
      style.leading = Number(spec.leadingPt);
    } catch (eL) {
      /* optional */
    }
  }
  if (spec.spaceBeforePt !== undefined && spec.spaceBeforePt !== null) {
    try {
      style.spaceBefore = Number(spec.spaceBeforePt);
    } catch (eB) {
      /* optional */
    }
  }
  if (spec.spaceAfterPt !== undefined && spec.spaceAfterPt !== null) {
    try {
      style.spaceAfter = Number(spec.spaceAfterPt);
    } catch (eA) {
      /* optional */
    }
  }
}

function mcpCopyTextStyleFromItem(style, styleKind, item) {
  var text;
  try {
    text = mcpGetTextForItem(item);
  } catch (e) {
    throw new Error("createStyle fromTarget requires a text item: " + (e.message || e));
  }
  try {
    if (styleKind === "character") {
      style.appliedFont = text.appliedFont;
      style.pointSize = text.pointSize;
    } else {
      style.appliedFont = text.appliedFont;
      style.pointSize = text.pointSize;
      try {
        style.leading = text.leading;
      } catch (eL) {
        /* ignore */
      }
      try {
        style.spaceBefore = text.spaceBefore;
        style.spaceAfter = text.spaceAfter;
      } catch (eSp) {
        /* ignore */
      }
      try {
        style.justification = text.justification;
      } catch (eJ) {
        /* ignore */
      }
    }
  } catch (e2) {
    throw new Error("copy style from item failed: " + (e2.message || e2));
  }
}

function opCreateStyle(cmd) {
  var doc = mcpRequireDoc();
  var styleKind = String(cmd.styleKind || "paragraph");
  var name = String(cmd.name);
  if (!name) throw new Error("createStyle requires name");

  var collection;
  if (styleKind === "character") collection = doc.characterStyles;
  else if (styleKind === "object") collection = doc.objectStyles;
  else collection = doc.paragraphStyles;

  try {
    var existing = collection.itemByName(name);
    if (existing && existing.isValid) {
      throw new Error("Style already exists (" + styleKind + "): " + name);
    }
  } catch (eEx) {
    if (String(eEx.message || eEx).indexOf("already exists") >= 0) throw eEx;
  }

  var style;
  try {
    style = collection.add({ name: name });
  } catch (eAdd) {
    throw new Error("createStyle failed: " + (eAdd.message || eAdd));
  }

  if (cmd.basedOn) {
    try {
      style.basedOn = mcpFindStyle(doc, styleKind, cmd.basedOn);
    } catch (eBased) {
      throw new Error("basedOn failed: " + (eBased.message || eBased));
    }
  }

  if (cmd.fromTarget) {
    var src = mcpFindByUuid(doc, cmd.fromTarget);
    if (styleKind === "object") {
      try {
        style.basedOn = src.appliedObjectStyle;
      } catch (eObj) {
        /* ignore — object style copy is best-effort */
      }
    } else {
      mcpCopyTextStyleFromItem(style, styleKind, src);
    }
  }

  if (cmd.spec) {
    mcpApplyStyleSpec(style, styleKind, cmd.spec);
  }

  mcpPatchStyles(doc);
  return {
    op: "createStyle",
    styleKind: styleKind,
    style: { name: String(style.name) },
    styles: gModelPatch.styles,
  };
}

function opUpdateStyle(cmd) {
  var doc = mcpRequireDoc();
  var styleKind = String(cmd.styleKind || "paragraph");
  var styleName = String(cmd.style || cmd.name);
  if (!styleName) throw new Error("updateStyle requires style name");
  var style = mcpFindStyle(doc, styleKind, styleName);

  if (cmd.basedOn) {
    try {
      style.basedOn = mcpFindStyle(doc, styleKind, cmd.basedOn);
    } catch (eBased) {
      throw new Error("basedOn failed: " + (eBased.message || eBased));
    }
  }

  if (cmd.fromTarget) {
    var src = mcpFindByUuid(doc, cmd.fromTarget);
    if (styleKind !== "object") {
      mcpCopyTextStyleFromItem(style, styleKind, src);
    }
  }

  if (cmd.spec) {
    mcpApplyStyleSpec(style, styleKind, cmd.spec);
  }

  if (cmd.newName) {
    try {
      style.name = String(cmd.newName);
    } catch (eN) {
      throw new Error("rename style failed: " + (eN.message || eN));
    }
  }

  mcpPatchStyles(doc);
  return {
    op: "updateStyle",
    styleKind: styleKind,
    style: { name: String(style.name) },
    styles: gModelPatch.styles,
  };
}

function opListAssets(cmd) {
  var doc = mcpRequireDoc();
  var links = mcpCollectLinks(doc);
  var statusFilter = cmd && cmd.status ? String(cmd.status) : null;
  if (statusFilter) {
    var filtered = [];
    var i;
    for (i = 0; i < links.length; i++) {
      if (links[i].status === statusFilter) filtered.push(links[i]);
    }
    links = filtered;
  }
  return { op: "listAssets", links: links, count: links.length };
}

function opCheckMissingLinks(cmd) {
  var doc = mcpRequireDoc();
  var links = mcpCollectLinks(doc);
  var missing = [];
  var outOfDate = [];
  var i;
  for (i = 0; i < links.length; i++) {
    var st = links[i].status;
    if (st === "LINK_MISSING" || st === "LINK_INACCESSIBLE") {
      missing.push(links[i]);
    } else if (st === "LINK_OUT_OF_DATE") {
      outOfDate.push(links[i]);
    }
  }
  return {
    op: "checkMissingLinks",
    missing: missing,
    outOfDate: outOfDate,
    ok: missing.length === 0,
    links: links,
  };
}

function opRelinkAsset(cmd) {
  var doc = mcpRequireDoc();
  var link = mcpFindLink(doc, cmd.linkId, cmd.name);
  var filePath = String(cmd.filePath || "");
  if (!filePath) throw new Error("relinkAsset requires filePath");
  var f = new File(filePath);
  if (!f.exists) {
    throw new Error("File not found: " + filePath);
  }
  try {
    link.relink(f);
  } catch (e) {
    throw new Error("relink failed: " + (e.message || e));
  }
  try {
    if (link.status === LinkStatus.LINK_OUT_OF_DATE) {
      link.update();
    }
  } catch (eU) {
    /* best-effort update */
  }
  mcpPatchLinks(doc);
  var refreshed = null;
  var all = gModelPatch.links || [];
  var i;
  for (i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(link.id) || String(all[i].name) === String(link.name)) {
      refreshed = all[i];
      break;
    }
  }
  return {
    op: "relinkAsset",
    link: refreshed,
    links: gModelPatch.links,
  };
}

function opEmbedAsset(cmd) {
  var doc = mcpRequireDoc();
  var link = mcpFindLink(doc, cmd.linkId, cmd.name);
  var linkId = String(link.id);
  try {
    link.unlink();
  } catch (e) {
    throw new Error("embed (unlink) failed: " + (e.message || e));
  }
  mcpPatchLinks(doc);
  return {
    op: "embedAsset",
    embeddedId: linkId,
    links: gModelPatch.links,
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
    case "checkpoint":
      return opCheckpoint(cmd);
    case "moveItem":
      return opMoveItem(cmd);
    case "resizeItem":
      return opResizeItem(cmd);
    case "deleteItem":
      return opDeleteItem(cmd);
    case "duplicateItem":
      return opDuplicateItem(cmd);
    case "createTextFrame":
      return opCreateTextFrame(cmd);
    case "setText":
      return opSetText(cmd);
    case "replaceText":
      return opReplaceText(cmd);
    case "setFont":
      return opSetFont(cmd);
    case "setFill":
      return opSetFill(cmd);
    case "alignItems":
      return opAlignItems(cmd);
    case "distributeItems":
      return opDistributeItems(cmd);
    case "centerItems":
      return opCenterItems(cmd);
    case "stackItems":
      return opStackItems(cmd);
    case "applyMargins":
      return opApplyMargins(cmd);
    case "listStyles":
      return opListStyles(cmd);
    case "applyStyle":
      return opApplyStyle(cmd);
    case "createStyle":
      return opCreateStyle(cmd);
    case "updateStyle":
      return opUpdateStyle(cmd);
    case "listAssets":
      return opListAssets(cmd);
    case "checkMissingLinks":
      return opCheckMissingLinks(cmd);
    case "relinkAsset":
    case "replaceAsset":
      return opRelinkAsset(cmd);
    case "embedAsset":
      return opEmbedAsset(cmd);
    default:
      throw new Error("Unknown op: " + cmd.op);
  }
}

function mcpNeedsPoints(commands) {
  // Keep Document Model + mutations in the same unit (points).
  if (app.documents.length === 0) return false;
  var i;
  for (i = 0; i < commands.length; i++) {
    if (!commands[i] || !commands[i].op) continue;
    var op = String(commands[i].op);
    if (op === "ping" || op === "noop" || op === "checkpoint") continue;
    return true;
  }
  return false;
}

/** Ops that write to the document — mirrored in src/commands/mutations.ts. */
var MCP_MUTATING_OPS = {
  moveItem: 1,
  resizeItem: 1,
  deleteItem: 1,
  duplicateItem: 1,
  createTextFrame: 1,
  setText: 1,
  replaceText: 1,
  setFont: 1,
  setFill: 1,
  alignItems: 1,
  distributeItems: 1,
  centerItems: 1,
  stackItems: 1,
  applyMargins: 1,
  applyStyle: 1,
  createStyle: 1,
  updateStyle: 1,
  relinkAsset: 1,
  replaceAsset: 1,
  embedAsset: 1,
};

function mcpHasMutation(commands) {
  var i;
  for (i = 0; i < commands.length; i++) {
    if (!commands[i] || !commands[i].op) continue;
    if (MCP_MUTATING_OPS[String(commands[i].op)] === 1) return true;
  }
  return false;
}

function mcpAsciiOnly(value) {
  return String(value).replace(/[^\x20-\x7E]/g, "?");
}

/* Where a throw inside the transaction happened; read by the outer catch,
   because app.doScript rethrows without saying which command died. */
var gFailedIndex = -1;
var gFailedOp = null;

function mcpMain() {
  var requestPath = arguments[0];
  var responsePath = arguments[1];
  var result;
  var transacted = false;
  var txName = "MCP batch";

  gFailedIndex = -1;
  gFailedOp = null;

  try {
    if (!requestPath || !responsePath) {
      throw new Error("dispatcher requires requestPath and responsePath arguments");
    }

    var payload = mcpParseJson(mcpReadFile(requestPath));
    var commands = payload.commands || [];
    var results = [];
    var done = [];
    var c;

    for (c = 0; c < commands.length; c++) {
      results.push(null);
      done.push(false);
    }

    if (payload.transactionName) {
      txName = mcpAsciiOnly(payload.transactionName).substring(0, 100);
    }

    gModelPatch = { updated: [], removed: [], styles: null, links: null };

    var prevInteraction = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel =
      UserInteractionLevels.NEVER_INTERACT;

    try {
      // Phase 1 — checkpoints, before the unit switch (so the copy keeps the
      // user's measurement units) and before the transaction (so a rollback
      // cannot take the safety copy with it).
      for (c = 0; c < commands.length; c++) {
        if (commands[c] && String(commands[c].op) === "checkpoint") {
          results[c] = runCommand(commands[c]);
          done[c] = true;
        }
      }

      var prevH = null;
      var prevV = null;
      var switchedUnits = false;
      if (app.documents.length > 0 && mcpNeedsPoints(commands)) {
        try {
          prevH = app.activeDocument.viewPreferences.horizontalMeasurementUnits;
          prevV = app.activeDocument.viewPreferences.verticalMeasurementUnits;
          app.activeDocument.viewPreferences.horizontalMeasurementUnits =
            MeasurementUnits.POINTS;
          app.activeDocument.viewPreferences.verticalMeasurementUnits =
            MeasurementUnits.POINTS;
          switchedUnits = true;
        } catch (eU) {
          switchedUnits = false;
        }
      }

      // Phase 2 — everything else, as one undo step. A throw in here reverts
      // the whole request instead of leaving the page half-rebuilt.
      var runRest = function () {
        var k;
        for (k = 0; k < commands.length; k++) {
          if (done[k]) continue;
          gFailedIndex = k;
          gFailedOp =
            commands[k] && commands[k].op ? String(commands[k].op) : "unknown";
          results[k] = runCommand(commands[k]);
          done[k] = true;
        }
        gFailedIndex = -1;
        gFailedOp = null;
        return results.length;
      };

      try {
        if (app.documents.length > 0 && mcpHasMutation(commands)) {
          transacted = true;
          app.doScript(
            runRest,
            ScriptLanguage.JAVASCRIPT,
            undefined,
            UndoModes.ENTIRE_SCRIPT,
            txName,
          );
        } else {
          runRest();
        }
      } finally {
        if (switchedUnits) {
          try {
            app.activeDocument.viewPreferences.horizontalMeasurementUnits = prevH;
            app.activeDocument.viewPreferences.verticalMeasurementUnits = prevV;
          } catch (eR) {
            /* ignore */
          }
        }
      }
    } finally {
      app.scriptPreferences.userInteractionLevel = prevInteraction;
    }

    var patch = null;
    if (
      gModelPatch.updated.length > 0 ||
      gModelPatch.removed.length > 0 ||
      gModelPatch.styles ||
      gModelPatch.links
    ) {
      patch = {
        updated: gModelPatch.updated,
        removed: gModelPatch.removed,
      };
      if (gModelPatch.styles) patch.styles = gModelPatch.styles;
      if (gModelPatch.links) patch.links = gModelPatch.links;
    }

    result = {
      ok: true,
      requestId: payload.requestId || null,
      results: results,
      modelPatch: patch,
      transaction: transacted
        ? { name: txName, undoMode: "ENTIRE_SCRIPT" }
        : null,
    };
  } catch (err) {
    var message = err && err.message ? String(err.message) : String(err);
    result = {
      ok: false,
      requestId: null,
      error: {
        message: message,
        name: err && err.name ? String(err.name) : "Error",
        failedIndex: gFailedIndex,
        failedOp: gFailedOp,
        rolledBack: transacted && gFailedIndex >= 0,
      },
      results: [],
      modelPatch: null,
      transaction: null,
    };
  }

  try {
    mcpWriteFile(responsePath, mcpStringify(result));
  } catch (writeErr) {
    throw writeErr;
  }
}

mcpMain(arguments[0], arguments[1]);
