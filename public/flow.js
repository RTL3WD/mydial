import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";

const HANDLES = [
  ["positive", "Interested"],
  ["no_answer", "No answer"],
  ["voicemail", "Voicemail"],
  ["not_interested", "Not interested"],
  ["dnc", "Do not call"],
  ["max", "Max attempts"],
];

function h(type, props, ...children) {
  return React.createElement(type, props, ...children.flat());
}

const box = {
  width: 210,
  borderRadius: 12,
  border: "1px solid #1a3144",
  background: "#0c1722",
  color: "#e8f4ff",
  padding: "10px 12px",
  fontSize: 13,
};

function shell(selected, extra) {
  return { ...box, ...extra, borderColor: selected ? "#3dffb0" : "#1a3144" };
}

function StartNode({ data, selected }) {
  return h("div", { style: shell(selected) },
    h(Handle, { type: "source", position: Position.Right, style: handleStyle }),
    h("div", { style: kicker }, "Start"),
    h("div", null, data.label || "Lead enrolled"));
}

function EndNode({ data, selected }) {
  return h("div", { style: shell(selected) },
    h(Handle, { type: "target", position: Position.Left, style: handleStyle }),
    h("div", { style: kicker }, "Exit"),
    h("div", null, data.label || "Leave the sequence"));
}

function WaitNode({ data, selected }) {
  return h("div", { style: shell(selected) },
    h(Handle, { type: "target", position: Position.Left, style: handleStyle }),
    h(Handle, { type: "source", position: Position.Right, style: handleStyle }),
    h("div", { style: kicker }, "Wait"),
    h("div", null, data.label || "Wait"),
    h("div", { style: meta }, `${Number(data.hours) || 0} hours`));
}

function EmailNode({ data, selected }) {
  return h("div", { style: shell(selected) },
    h(Handle, { type: "target", position: Position.Left, style: handleStyle }),
    h(Handle, { type: "source", position: Position.Right, style: handleStyle }),
    h("div", { style: kicker }, data.autoSend ? "Email · send" : "Email · draft"),
    h("div", null, data.label || data.subject || "Email"));
}

function DialNode({ data, selected }) {
  return h("div", { style: shell(selected, { width: 230, paddingBottom: 8 }) },
    h(Handle, { type: "target", position: Position.Left, style: handleStyle }),
    h("div", { style: kicker }, "Dial"),
    h("div", { style: { marginBottom: 8 } }, data.label || "Power dial"),
    HANDLES.map(([id, label]) => h("div", {
      key: id,
      style: { position: "relative", textAlign: "right", fontSize: 10, color: "#8eabc0", lineHeight: "18px", paddingRight: 8 },
    }, label, h(Handle, {
      type: "source",
      position: Position.Right,
      id,
      style: handleStyle,
    }))));
}

const handleStyle = { width: 8, height: 8, background: "#3dffb0", border: "none" };
const kicker = { fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8eabc0", marginBottom: 4 };
const meta = { marginTop: 4, fontSize: 11, color: "#8eabc0" };
const field = {
  width: "100%",
  marginTop: 4,
  borderRadius: 8,
  border: "1px solid #1a3144",
  background: "#071018",
  color: "#e8f4ff",
  padding: "6px 8px",
  font: "inherit",
};

const nodeTypes = { start: StartNode, dial: DialNode, email: EmailNode, wait: WaitNode, end: EndNode };

function Builder({ flow, cadence, saved, onSave }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(flow.nodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow.edges || []);
  const [selected, setSelected] = useState(flow.nodes?.[0]?.id || null);
  const [rules, setRules] = useState({
    windowStart: cadence?.windowStart || "09:00",
    windowEnd: cadence?.windowEnd || "16:30",
    skipWeekends: cadence?.skipWeekends !== false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = nodes.find((node) => node.id === selected) || null;

  const onConnect = useCallback((connection) => {
    setEdges((currentEdges) => addEdge({
      ...connection,
      id: `e-${crypto.randomUUID().slice(0, 8)}`,
      label: connection.sourceHandle || "",
    }, currentEdges));
  }, [setEdges]);

  function updateData(patch) {
    setNodes((currentNodes) => currentNodes.map((node) => (
      node.id === selected ? { ...node, data: { ...node.data, ...patch } } : node
    )));
  }

  function addNode(type) {
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    const data = {
      label: type === "dial" ? "Power dial" : type === "email" ? "Follow-up email" : type === "wait" ? "Wait" : "Exit sequence",
      hours: 4,
      maxAttempts: 3,
      subject: "Following up",
      body: "Hi {{first_name}}, I tried you earlier about {{company}}.",
      autoSend: false,
    };
    setNodes((currentNodes) => currentNodes.concat({ id, type, position: { x: 80 + currentNodes.length * 24, y: 80 }, data }));
    setSelected(id);
  }

  function removeNode() {
    if (!current || current.type === "start") return;
    setNodes((currentNodes) => currentNodes.filter((node) => node.id !== current.id));
    setEdges((currentEdges) => currentEdges.filter((edge) => edge.source !== current.id && edge.target !== current.id));
    setSelected(null);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSave({
        flow: { nodes, edges },
        cadence: { ...cadence, ...rules },
      });
    } catch (err) {
      setError(err.message || "Could not save the flow.");
    } finally {
      setSaving(false);
    }
  }

  return h("div", { style: { display: "flex", height: "100%", background: "#071018" } },
    h("div", { style: { flex: 1, minWidth: 0 } },
      h(ReactFlow, {
        nodes,
        edges,
        onNodesChange,
        onEdgesChange,
        onConnect,
        nodeTypes,
        colorMode: "dark",
        fitView: true,
        onSelectionChange: ({ nodes: picked }) => setSelected(picked[0]?.id || null),
        defaultEdgeOptions: { type: "smoothstep", style: { stroke: "#3dffb0" }, labelStyle: { fill: "#b7d3e6", fontSize: 10 } },
      },
      h(Background, { gap: 18, color: "#163042" }),
      h(Controls, null),
      h(MiniMap, { pannable: true, zoomable: true, maskColor: "rgba(7,16,24,0.7)" }))),
    h("aside", { style: { width: 300, overflow: "auto", borderLeft: "1px solid #1a3144", padding: 16, background: "#0c1722" } },
      h("p", { style: { fontSize: 12, color: "#8eabc0", lineHeight: 1.5 } },
        saved
          ? "Saved flows route the next step after each outcome."
          : "This graph is a draft. The linear cadence still runs until you save."),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 } },
        ["dial", "email", "wait", "end"].map((type) => h("button", {
          key: type,
          type: "button",
          onClick: () => addNode(type),
          style: buttonStyle,
        }, `+ ${type}`))),
      current ? inspector(current, updateData, removeNode) : h("p", { style: { marginTop: 16, fontSize: 12, color: "#8eabc0" } }, "Select a node to edit it."),
      h("div", { style: { marginTop: 16, paddingTop: 12, borderTop: "1px solid #1a3144" } },
        h("p", { style: { fontSize: 12, fontWeight: 600 } }, "Calling window"),
        h("div", { style: { display: "flex", gap: 8 } },
          h("input", { style: field, value: rules.windowStart, onChange: (event) => setRules({ ...rules, windowStart: event.target.value }) }),
          h("input", { style: field, value: rules.windowEnd, onChange: (event) => setRules({ ...rules, windowEnd: event.target.value }) })),
        h("label", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 12 } },
          h("input", { type: "checkbox", checked: rules.skipWeekends, onChange: (event) => setRules({ ...rules, skipWeekends: event.target.checked }) }),
          "Skip weekends")),
      error ? h("p", { style: { color: "#fda4af", fontSize: 12, marginTop: 8 } }, error) : null,
      h("button", {
        type: "button",
        onClick: save,
        disabled: saving,
        style: { ...buttonStyle, marginTop: 14, background: "#3dffb0", color: "#071018", border: "none", fontWeight: 600 },
      }, saving ? "Saving…" : "Save flow")));
}

function inspector(node, updateData, removeNode) {
  const data = node.data || {};
  return h("div", { style: { marginTop: 16 } },
    h("p", { style: { fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8eabc0" } }, node.type),
    h("label", { style: label }, "Label",
      h("input", { style: field, value: data.label || "", onChange: (event) => updateData({ label: event.target.value }) })),
    node.type === "dial" ? h("label", { style: label }, "Max attempts before the max exit",
      h("input", { style: field, type: "number", min: 1, value: data.maxAttempts || 3, onChange: (event) => updateData({ maxAttempts: Number(event.target.value) }) })) : null,
    node.type === "wait" ? h("label", { style: label }, "Hours",
      h("input", { style: field, type: "number", min: 0, value: data.hours || 0, onChange: (event) => updateData({ hours: Number(event.target.value) }) })) : null,
    node.type === "email" ? h(React.Fragment, null,
      h("label", { style: label }, "Subject",
        h("input", { style: field, value: data.subject || "", onChange: (event) => updateData({ subject: event.target.value }) })),
      h("label", { style: label }, "Body",
        h("textarea", { style: { ...field, minHeight: 90 }, value: data.body || "", onChange: (event) => updateData({ body: event.target.value }) })),
      h("label", { style: { ...label, display: "flex", gap: 8, alignItems: "center" } },
        h("input", { type: "checkbox", checked: Boolean(data.autoSend), onChange: (event) => updateData({ autoSend: event.target.checked }) }),
        "Send when SMTP is saved. Otherwise keep a draft.")) : null,
    node.type === "start" ? null : h("button", { type: "button", onClick: removeNode, style: { ...buttonStyle, marginTop: 12, color: "#fda4af" } }, "Remove node"));
}

const label = { display: "block", marginTop: 10, fontSize: 12, color: "#8eabc0" };
const buttonStyle = {
  borderRadius: 8,
  border: "1px solid #1a3144",
  background: "transparent",
  color: "#d7e6f2",
  padding: "6px 8px",
  fontSize: 12,
  cursor: "pointer",
};

export function defaultFlow() {
  return {
    nodes: [
      { id: "start", type: "start", position: { x: 40, y: 180 }, data: { label: "Lead enrolled" } },
      { id: "dial-1", type: "dial", position: { x: 300, y: 120 }, data: { label: "Power dial", maxAttempts: 3 } },
      { id: "wait-1", type: "wait", position: { x: 600, y: 20 }, data: { label: "Wait", hours: 4 } },
      { id: "email-1", type: "email", position: { x: 600, y: 300 }, data: { label: "Follow-up email", subject: "Following up", body: "Hi {{first_name}}, I tried you earlier about {{company}}.", autoSend: false } },
      { id: "end", type: "end", position: { x: 900, y: 180 }, data: { label: "Exit sequence" } },
    ],
    edges: [
      { id: "e-start", source: "start", target: "dial-1" },
      { id: "e-na", source: "dial-1", target: "wait-1", sourceHandle: "no_answer", label: "no_answer" },
      { id: "e-vm", source: "dial-1", target: "email-1", sourceHandle: "voicemail", label: "voicemail" },
      { id: "e-pos", source: "dial-1", target: "end", sourceHandle: "positive", label: "positive" },
      { id: "e-ni", source: "dial-1", target: "end", sourceHandle: "not_interested", label: "not_interested" },
      { id: "e-dnc", source: "dial-1", target: "end", sourceHandle: "dnc", label: "dnc" },
      { id: "e-max", source: "dial-1", target: "end", sourceHandle: "max", label: "max" },
      { id: "e-wait", source: "wait-1", target: "dial-1" },
      { id: "e-email", source: "email-1", target: "end" },
    ],
  };
}

export function mount(element, props) {
  const root = createRoot(element);
  root.render(h(Builder, props));
  return root;
}
