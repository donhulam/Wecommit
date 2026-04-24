/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Brain, 
  Zap, 
  Search, 
  PenTool, 
  CheckCircle, 
  Send, 
  RotateCcw, 
  ChevronDown, 
  ChevronUp, 
  Check, 
  AlertCircle,
  Clock,
  ArrowRight
} from "lucide-react";
import { callAgent } from "./lib/gemini";

// ─── SYSTEM PROMPTS ──────────────────────────────────────────────────────────

const EMOTION_AGENT_SYSTEM = `Bạn là Emotion Agent trong hệ thống Multi-Agent của Wecommit. Nhiệm vụ: phân tích ý định và cảm xúc từ email/câu hỏi của khách hàng.

QUAN TRỌNG: Chỉ chấp nhận câu hỏi liên quan tới khóa học Agentic AI của Wecommit.

Trả về JSON duy nhất, không thêm bất kỳ văn bản nào:
{
  "analysis_layer": {
    "is_relevant": true/false,
    "rejection_reason": "lý do nếu không liên quan, hoặc null",
    "intent_category": "Course_Inquiry | Technical_Support | General_Feedback | Partnership | Irrelevant",
    "sentiment_score": số từ -1 đến 1,
    "sentiment_label": "Hứng khởi | Lo lắng | Thất vọng | Bình thường | Chuyên nghiệp | Cần gấp",
    "keywords": ["từ khóa 1", "từ khóa 2"],
    "urgency_level": "High | Medium | Low",
    "customer_name": "tên khách hàng nếu tìm thấy, hoặc null"
  }
}`;

const LEADER_AGENT_SYSTEM = `Bạn là Leader Agent trong hệ thống Multi-Agent của Wecommit. Nhận phân tích từ Emotion Agent và quyết định luồng tiếp theo.

Trả về JSON duy nhất:
{
  "strategy_layer": {
    "next_agent": "Check_RAG_Agent" hoặc "Writer_Agent",
    "route": "KNOWLEDGE_TRACK" hoặc "DIRECT_TRACK",
    "reasoning": "lý do ngắn gọn",
    "keywords_for_rag": ["từ khóa cần tra cứu"] hoặc [],
    "recommended_persona": {
      "name": "tên persona",
      "tone": "mô tả giọng văn",
      "instruction": "hướng dẫn cụ thể cho Writer Agent"
    }
  }
}

Quy tắc: Nếu câu hỏi cần thông tin thực tế (học phí, lịch khai giảng, kinh nghiệm giảng viên, nội dung khóa học...) → next_agent = "Check_RAG_Agent". Nếu chỉ là xã giao, khen ngợi, cảm ơn → next_agent = "Writer_Agent".`;

const CHECK_RAG_AGENT_SYSTEM = `Bạn là Check RAG Agent trong hệ thống Wecommit. Bạn KHÔNG có tài liệu nội bộ thực tế, nên hãy mô phỏng việc tra cứu và trả về kết quả thực tế nhất có thể về khóa học Agentic AI của Wecommit dựa trên kiến thức chung về AI training courses tại Việt Nam.

Trả về JSON duy nhất:
{
  "knowledge_layer": {
    "key_word": "từ khóa đã tra",
    "confirmed_facts": "- Fact 1 | Nguồn: File/Website\n- Fact 2 | Nguồn: ...",
    "missing_info": "thông tin còn thiếu hoặc 'none'"
  }
}

Lưu ý: Chỉ dùng gạch đầu dòng, không viết văn xuôi. Mỗi dòng phải có "| Nguồn:". Không được bịa thông tin quá cụ thể như số điện thoại hay giá tiền chính xác nếu không chắc chắn - hãy ghi rõ "Liên hệ để biết thêm".`;

const WRITER_AGENT_SYSTEM = `Bạn là Writer Agent - chuyên gia viết email CSKH tại Wecommit AI. Soạn email phản hồi chuyên nghiệp dựa trên thông tin nhận được.

Trả về JSON duy nhất:
{
  "production_layer": {
    "subject": "tiêu đề email",
    "current_draft": "nội dung email đầy đủ",
    "version": số phiên bản
  }
}

Cấu trúc email: Subject Line → Salutation cá nhân hóa → Opening thấu cảm → Main Body với bullet points → Closing & CTA chuyên nghiệp.
Tuyệt đối giữ nguyên số liệu từ RAG, không bịa thêm.`;

const QA_AGENT_SYSTEM = `Bạn là QA Agent - Thanh tra chất lượng nội dung của Wecommit. Đánh giá bản thảo email theo các tiêu chí sau:
1. Fact-Check: Các thông tin có khớp với dữ liệu RAG không?
2. Tone-Check: Giọng văn có đúng Persona được Leader đề xuất không?
3. Completeness: Email có đủ cấu trúc (Subject, Salutation, Body, CTA) không?
4. Human Touch: Email có tự nhiên, không máy móc không?
5. Clarity: Ngôn từ rõ ràng, dễ hiểu không?

Trả về JSON duy nhất:
{
  "evaluation_layer": {
    "status": "PASS" hoặc "FAILED",
    "scores": {
      "fact_check": số 1-10,
      "tone_check": số 1-10,
      "completeness": số 1-10,
      "human_touch": số 1-10,
      "clarity": số 1-10
    },
    "issues_found": ["vấn đề 1 nếu có"],
    "correction_guide": "hướng dẫn sửa chi tiết nếu FAILED, hoặc null"
  }
}

PASS nếu tất cả các điểm >= 7 VÀ không có lỗi fact-check nghiêm trọng.`;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const AGENT_META: any = {
  emotion: { label: "Emotion Agent", icon: Brain, color: "#7C3AED", bg: "#EDE9FE" },
  leader:  { label: "Leader Agent",  icon: Zap, color: "#0369A1", bg: "#E0F2FE" },
  rag:     { label: "Check RAG Agent", icon: Search, color: "#047857", bg: "#D1FAE5" },
  writer:  { label: "Writer Agent",  icon: PenTool, color: "#B45309", bg: "#FEF3C7" },
  qa:      { label: "QA Agent",      icon: CheckCircle, color: "#BE123C", bg: "#FFE4E6" },
};

const STEP_LABELS = [
  { id: "emotion", label: "Phân tích cảm xúc" },
  { id: "leader",  label: "Điều phối luồng" },
  { id: "rag",     label: "Tra cứu dữ liệu" },
  { id: "writer",  label: "Soạn email draft" },
  { id: "qa",      label: "Kiểm định chất lượng" },
];

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function AgentBadge({ id, active, done }: { id: string; active: boolean; done: boolean }) {
  const m = AGENT_META[id];
  const Icon = m.icon;
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border-2 transition-all duration-300 ${active || done ? 'opacity-100' : 'opacity-50'}`} 
      style={{
        background: done || active ? m.bg : "#F3F4F6",
        borderColor: active || done ? m.color : "#E5E7EB",
      }}>
      <Icon size={16} color={active || done ? m.color : "#9CA3AF"} />
      <span className="text-xs font-bold" style={{ color: active || done ? m.color : "#9CA3AF" }}>
        {m.label}
      </span>
      {done && <Check size={12} color={m.color} className="ml-1" />}
      {active && <Clock size={12} color={m.color} className="ml-1 animate-pulse" />}
    </div>
  );
}

function AgentCard({ id, data, isLoading }: { id: string; data: any; isLoading: boolean; key?: string }) {
  const m = AGENT_META[id];
  const Icon = m.icon;
  const [open, setOpen] = useState(false);
  
  if (!data && !isLoading) return null;
  
  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border h-fit overflow-hidden bg-white mb-3 shadow-sm"
      style={{ borderColor: `${m.color}40` }}
    >
      <div
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        style={{ background: m.bg }}
      >
        <Icon size={20} color={m.color} />
        <span className="font-bold flex-1" style={{ color: m.color }}>{m.label}</span>
        {isLoading ? (
          <span className="text-xs animate-pulse" style={{ color: m.color }}>Đang xử lý...</span>
        ) : (
          <div className="flex items-center gap-1 text-[10px] uppercase font-bold" style={{ color: m.color }}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {open ? "Thu gọn" : "Chi tiết"}
          </div>
        )}
      </div>
      <AnimatePresence>
        {open && data && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <pre className="m-0 p-4 text-[11px] leading-relaxed bg-slate-50 text-slate-700 overflow-x-auto whitespace-pre-wrap break-words border-t border-slate-100 font-mono">
              {JSON.stringify(data, null, 2)}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ScoreBadge({ label, score }: { label: string; score: number; key?: string }) {
  const color = score >= 8 ? "#047857" : score >= 6 ? "#B45309" : "#BE123C";
  return (
    <div className="text-center">
      <div 
        className="w-10 h-10 rounded-full flex items-center justify-center font-extrabold text-sm mx-auto mb-1 text-white shadow-sm"
        style={{ background: color }}
      >
        {score}
      </div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">{label}</div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

export default function WecommitAgentFlow() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "awaiting_approval" | "done">("idle");
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [doneAgents, setDoneAgents] = useState<string[]>([]);
  const [results, setResults] = useState<any>({});
  const [log, setLog] = useState<any[]>([]);
  const [iterCount, setIterCount] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [finalEmail, setFinalEmail] = useState<any>(null);
  const [skippedRag, setSkippedRag] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function addLog(agent: string, msg: string, type: "info" | "success" | "error" | "warn" | "system" | "skip" = "info") {
    setLog(prev => [...prev, { agent, msg, type, ts: Date.now() }]);
  }

  async function runFlow(userInput: string, writerContext: any = null) {
    const currentIter = iterCount + 1;
    setIterCount(currentIter);
    setDoneAgents([]);
    setActiveAgent(null);
    setSkippedRag(false);

    addLog("system", `═══ Bắt đầu vòng lặp #${currentIter} ═══`, "system");

    try {
      // ── STEP 1: EMOTION AGENT ──
      setActiveAgent("emotion");
      addLog("emotion", "Đang phân tích ý định và cảm xúc...");
      const emotionResult = await callAgent(EMOTION_AGENT_SYSTEM, userInput);
      setResults((r: any) => ({ ...r, emotion: emotionResult }));
      setDoneAgents(d => [...d, "emotion"]);
      setActiveAgent(null);

      const analysis = emotionResult?.analysis_layer;
      if (!analysis?.is_relevant) {
        addLog("emotion", `Câu hỏi không liên quan: ${analysis?.rejection_reason || "Không phù hợp"}`, "warn");
        setPhase("idle");
        setResults((r: any) => ({ ...r, rejection: analysis?.rejection_reason }));
        return;
      }
      addLog("emotion", `✓ Phân tích xong. Sentiment: ${analysis?.sentiment_label} | Intent: ${analysis?.intent_category}`, "success");

      // ── STEP 2: LEADER AGENT ──
      setActiveAgent("leader");
      addLog("leader", "Đang quyết định luồng xử lý...");
      const leaderResult = await callAgent(
        LEADER_AGENT_SYSTEM,
        `Input của người dùng: "${userInput}"\nEmotion Analysis: ${JSON.stringify(emotionResult)}`
      );
      setResults((r: any) => ({ ...r, leader: leaderResult }));
      setDoneAgents(d => [...d, "leader"]);
      setActiveAgent(null);

      const strategy = leaderResult?.strategy_layer;
      const needRAG = strategy?.next_agent === "Check_RAG_Agent";
      addLog("leader", `✓ Luồng: ${strategy?.route} → ${strategy?.next_agent}`, "success");

      // ── STEP 3: CHECK RAG AGENT (conditional) ──
      let ragResult = null;
      if (needRAG) {
        setActiveAgent("rag");
        addLog("rag", `Tra cứu keywords: ${strategy?.keywords_for_rag?.join(", ") || "..."}`);
        ragResult = await callAgent(
          CHECK_RAG_AGENT_SYSTEM,
          `Keywords cần tra cứu: ${JSON.stringify(strategy?.keywords_for_rag)}\nCâu hỏi gốc: "${userInput}"`
        );
        setResults((r: any) => ({ ...r, rag: ragResult }));
        setDoneAgents(d => [...d, "rag"]);
        setActiveAgent(null);
        addLog("rag", "✓ Tra cứu hoàn tất", "success");
      } else {
        setSkippedRag(true);
        addLog("rag", "⏭ Bỏ qua (Direct Track - không cần RAG)", "skip");
        setResults((r: any) => ({ ...r, rag: null }));
      }

      // ── STEP 4: WRITER AGENT ──
      setActiveAgent("writer");
      const writerVersion = writerContext ? writerContext.version + 1 : 1;
      addLog("writer", `Soạn email draft v${writerVersion}...`);
      const writerInput = {
        user_query: userInput,
        emotion_analysis: emotionResult,
        strategy: leaderResult,
        rag_data: ragResult,
        previous_draft: writerContext?.draft || null,
        user_feedback: writerContext?.feedback || null,
        version: writerVersion,
      };
      const writerResult = await callAgent(
        WRITER_AGENT_SYSTEM,
        `Hãy soạn email phản hồi v${writerVersion} dựa trên:\n${JSON.stringify(writerInput, null, 2)}`
      );
      setResults((r: any) => ({ ...r, writer: writerResult }));
      setDoneAgents(d => [...d, "writer"]);
      setActiveAgent(null);
      addLog("writer", `✓ Draft v${writerVersion} hoàn tất`, "success");

      // ── STEP 5: QA AGENT ──
      setActiveAgent("qa");
      addLog("qa", "Đang kiểm định chất lượng...");
      const qaResult = await callAgent(
        QA_AGENT_SYSTEM,
        `Bản thảo cần đánh giá:\n${JSON.stringify(writerResult)}\n\nDữ liệu tham chiếu:\nRAG: ${JSON.stringify(ragResult)}\nStrategy: ${JSON.stringify(leaderResult)}`
      );
      setResults((r: any) => ({ ...r, qa: qaResult }));
      setDoneAgents(d => [...d, "qa"]);
      setActiveAgent(null);

      const evaluation = qaResult?.evaluation_layer;
      const passed = evaluation?.status === "PASS";

      if (!passed) {
        addLog("qa", `✗ QA FAILED. Lý do: ${evaluation?.correction_guide}`, "error");
        addLog("system", "→ Quay lại Writer Agent để sửa...", "system");
        // Recursive call to fix the draft
        await runFlow(userInput, {
          draft: writerResult,
          feedback: evaluation?.correction_guide,
          version: writerVersion,
        });
      } else {
        addLog("qa", "✓ QA PASSED! Chuyển cho người dùng duyệt.", "success");
        setPhase("awaiting_approval");
      }
    } catch (err) {
      console.error(err);
      addLog("system", "Có lỗi xảy ra trong quá trình xử lý.", "error");
      setPhase("idle");
    }
  }

  async function handleStart() {
    if (!input.trim()) return;
    setPhase("running");
    setResults({});
    setLog([]);
    setIterCount(0);
    setFinalEmail(null);
    setFeedback("");
    await runFlow(input.trim());
  }

  function handleApprove() {
    const draft = results.writer?.production_layer;
    setFinalEmail(draft);
    setPhase("done");
    addLog("system", "✅ Người dùng đã DUYỆT. Luồng kết thúc thành công.", "success");
  }

  async function handleReject() {
    if (!feedback.trim()) return;
    addLog("system", `Người dùng YÊU CẦU SỬA: ${feedback}`, "warn");
    setPhase("running");
    const draft = results.writer;
    const currentVersion = draft?.production_layer?.version || 1;
    await runFlow(input.trim(), {
      draft,
      feedback: feedback.trim(),
      version: currentVersion,
    });
    setFeedback("");
  }

  const draft = results.writer?.production_layer;
  const qaEval = results.qa?.evaluation_layer;
  const rejected = results.rejection;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 selection:bg-indigo-500/30">
      <div className="max-w-4xl mx-auto">
        
        {/* HEADER */}
        <div className="text-center mb-10">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-4 py-1.5 mb-6 shadow-glow"
          >
            <Brain size={18} className="text-indigo-400" />
            <span className="text-indigo-400 font-bold text-xs uppercase tracking-widest">Wecommit AI · Multi-Agent System</span>
          </motion.div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-4 tracking-tight">
            Hệ thống Tư vấn <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-violet-400">Agentic AI</span>
          </h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed">
            Quy trình làm việc thông minh gồm 5 AI Agents chuyên biệt phối hợp phân tích, 
            tra cứu và phản hồi khách hàng tự động.
          </p>
        </div>

        {/* PIPELINE VISUALIZATION */}
        <div className="flex flex-wrap gap-2 items-center justify-center bg-white/5 border border-white/10 rounded-2xl p-6 mb-8 shadow-inner">
          {STEP_LABELS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <AgentBadge
                id={s.id}
                active={activeAgent === s.id}
                done={doneAgents.includes(s.id)}
              />
              {i < STEP_LABELS.length - 1 && (
                <ArrowRight size={14} className="text-slate-700 mx-1" />
              )}
            </div>
          ))}
        </div>

        {/* CONTENT AREA */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          
          {/* LEFT COLUMN: Input or Results */}
          <div className="space-y-4">
            {phase === "idle" ? (
              <motion.div 
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white rounded-2xl p-6 shadow-xl"
              >
                <div className="flex items-center gap-2 mb-4">
                  <Send size={18} className="text-indigo-600" />
                  <h2 className="text-slate-900 font-bold text-lg">Soạn yêu cầu mới</h2>
                </div>
                <textarea
                  id="query-input"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Ví dụ: Chào Wecommit, mình muốn hỏi về lịch khai giảng khóa Agentic AI gần nhất? Mình đang cần triển khai gấp cho công cụ AI tại công ty..."
                  className="w-full min-h-[160px] p-4 border-2 border-slate-100 rounded-xl text-slate-800 text-sm focus:border-indigo-500 focus:ring-0 transition-colors resize-none placeholder:text-slate-400 font-medium leading-relaxed"
                />
                <div className="mt-4 flex flex-wrap gap-2">
                  {[
                    "Hỏi về lịch khai giảng khóa Agentic AI?",
                    "Thầy Huy có bao nhiêu năm kinh nghiệm?",
                    "Cảm ơn Wecommit đã hỗ trợ!"
                  ].map(ex => (
                    <button
                      key={ex}
                      onClick={() => setInput(ex)}
                      className="px-3 py-1.5 rounded-lg border border-indigo-100 bg-indigo-50 text-indigo-700 text-[10px] font-bold uppercase transition-all hover:bg-indigo-100"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
                <button
                  id="start-btn"
                  onClick={handleStart}
                  disabled={!input.trim()}
                  className="w-full mt-6 py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-100 disabled:text-slate-400 text-white rounded-xl font-bold transition-all shadow-lg shadow-indigo-600/20 active:scale-95 disabled:active:scale-100"
                >
                  Bắt đầu quy trình Multi-Agent
                </button>
              </motion.div>
            ) : (
              <div className="space-y-3">
                <h3 className="text-white/60 font-bold text-[10px] uppercase tracking-widest flex items-center gap-2">
                  <Zap size={12} /> Nhật ký Agents
                </h3>
                {STEP_LABELS.map(s => (
                  (s.id !== "rag" || !skippedRag) && (
                    <AgentCard
                      key={s.id}
                      id={s.id}
                      data={results[s.id]}
                      isLoading={activeAgent === s.id}
                    />
                  )
                ))}
                {skippedRag && (
                  <div className="p-4 rounded-xl border border-dashed border-slate-800 bg-slate-900/50 text-slate-500 text-xs flex items-center gap-3">
                    <Search size={16} />
                    <span>Check RAG Agent — <em className="text-slate-600">Đã bỏ qua (Direct Track)</em></span>
                  </div>
                )}
              </div>
            )}

            {rejected && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-red-500/10 border border-red-500/20 rounded-xl p-5"
              >
                <div className="flex items-center gap-2 text-red-400 mb-2 font-bold">
                  <AlertCircle size={18} />
                  <span>Nội dung bị từ chối</span>
                </div>
                <p className="text-red-300/80 text-sm leading-relaxed">{rejected}</p>
                <button 
                  onClick={() => { setPhase("idle"); setResults({}); setLog([]); }}
                  className="mt-4 text-red-400 font-bold text-xs uppercase flex items-center gap-1 hover:underline"
                >
                  <RotateCcw size={12} /> Quay lại trang chủ
                </button>
              </motion.div>
            )}
          </div>

          {/* RIGHT COLUMN: Activity & Draft */}
          <div className="space-y-6">
            
            {/* ACTIVITY LOG */}
            {(phase !== "idle") && (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden flex flex-col h-60">
                <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
                  <span className="text-slate-400 text-[10px] font-bold uppercase tracking-widest">Trình theo dõi (Logs)</span>
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-emerald-500/80 text-[10px] font-bold">Vòng lặp #{iterCount}</span>
                  </div>
                </div>
                <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-2 font-mono">
                  {log.map((l, i) => {
                    const colors: any = { 
                      success: "text-emerald-400", 
                      error: "text-rose-400", 
                      warn: "text-amber-400", 
                      system: "text-indigo-400", 
                      skip: "text-slate-500", 
                      info: "text-slate-300" 
                    };
                    const m = AGENT_META[l.agent];
                    return (
                      <div key={i} className={`text-[10px] flex gap-2 ${colors[l.type] || "text-slate-300"}`}>
                        {m && <span className="font-bold opacity-70">[{m.label.split(" ")[0]}]</span>}
                        <span className="flex-1 leading-relaxed">{l.msg}</span>
                      </div>
                    );
                  })}
                  {activeAgent && (
                    <div className="text-indigo-400 text-[10px] font-bold flex items-center gap-2 animate-pulse">
                      <Clock size={10} /> Đang tải dữ liệu...
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* QA SCORES & RESULTS */}
            <AnimatePresence>
              {qaEval && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`bg-white rounded-2xl p-6 border-l-8 shadow-xl ${qaEval.status === "PASS" ? "border-emerald-500" : "border-rose-500"}`}
                >
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="text-slate-900 font-black text-xl">Kiểm định Chất lượng</h3>
                    <div className={`px-4 py-1 rounded-full text-xs font-black uppercase tracking-widest ${qaEval.status === "PASS" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {qaEval.status === "PASS" ? "✓ Đạt chuẩn" : "✗ Không đạt"}
                    </div>
                  </div>
                  
                  {qaEval.scores && (
                    <div className="grid grid-cols-3 gap-y-6 gap-x-2 mb-6">
                      {Object.entries(qaEval.scores).map(([k, v]: [string, any]) => (
                        <ScoreBadge key={k} label={k.replace(/_/g, " ")} score={v} />
                      ))}
                    </div>
                  )}

                  {qaEval.correction_guide && (
                    <div className="p-4 rounded-xl bg-rose-50 border border-rose-100 text-rose-800 text-xs leading-relaxed italic">
                      <span className="font-bold block mb-1 uppercase not-italic">Lưu ý từ QA Agent:</span>
                      {qaEval.correction_guide}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* FINAL OR DRAFT EMAIL */}
            <AnimatePresence>
              {draft && phase === "awaiting_approval" && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-white rounded-2xl overflow-hidden shadow-2xl border-4 border-indigo-500/20"
                >
                  <div className="bg-indigo-600 px-6 py-4 text-white flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Send size={18} />
                      <span className="font-black">Email Draft v{draft.version}</span>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest bg-white/20 px-2 py-0.5 rounded">Chờ duyệt</span>
                  </div>
                  <div className="p-6">
                    <div className="mb-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      <span className="text-xs text-slate-400 font-bold uppercase block mb-1">Tiêu đề:</span>
                      <p className="text-slate-900 font-bold text-sm tracking-tight">{draft.subject}</p>
                    </div>
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 min-h-[200px] mb-6">
                      <pre className="text-sm text-slate-800 font-medium font-sans whitespace-pre-wrap leading-relaxed">
                        {draft.current_draft}
                      </pre>
                    </div>

                    <div className="space-y-4">
                      <button 
                        onClick={handleApprove}
                        className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-lg shadow-emerald-600/20 active:scale-95"
                      >
                        Chấp nhận và Gửi
                      </button>

                      <div className="relative">
                        <textarea
                          value={feedback}
                          onChange={e => setFeedback(e.target.value)}
                          placeholder="Góp ý để sửa lại email này..."
                          className="w-full min-h-[80px] p-4 bg-slate-50 border-2 border-slate-100 rounded-xl text-slate-800 text-xs focus:border-rose-400 focus:ring-0 transition-colors resize-none placeholder:text-slate-400"
                        />
                        <button
                          onClick={handleReject}
                          disabled={!feedback.trim()}
                          className="w-full mt-2 py-3 bg-rose-500 hover:bg-rose-600 disabled:bg-slate-100 disabled:text-slate-400 text-white rounded-xl font-bold text-xs uppercase tracking-widest transition-all active:scale-95 disabled:active:scale-100"
                        >
                          Yêu cầu sửa lại bản thảo
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* DONE PHASE */}
            <AnimatePresence>
              {phase === "done" && finalEmail && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-emerald-50 border border-emerald-200 rounded-2xl p-8 shadow-xl"
                >
                  <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4 border-4 border-white shadow-sm">
                      <Check size={32} className="text-emerald-600" />
                    </div>
                    <h3 className="text-emerald-900 font-black text-2xl tracking-tight">Hoàn tất quy trình!</h3>
                    <p className="text-emerald-700/70 font-medium">Email đã được phê duyệt và sẵn sàng gửi đi.</p>
                  </div>
                  
                  <div className="bg-white p-6 rounded-2xl border border-emerald-100 shadow-sm mb-8">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Subject: {finalEmail.subject}</h4>
                    <pre className="text-slate-800 text-sm font-medium font-sans whitespace-pre-wrap leading-relaxed line-clamp-10 overflow-hidden">
                      {finalEmail.current_draft}
                    </pre>
                  </div>

                  <button
                    onClick={() => { setPhase("idle"); setResults({}); setLog([]); setInput(""); setIterCount(0); setFinalEmail(null); }}
                    className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all active:scale-95"
                  >
                    Xử lý email mới
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
            
          </div>
        </div>

        {/* FOOTER */}
        <div className="mt-16 pt-8 border-t border-white/10 text-center">
          <p className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em]">
            Hệ thống Multi-Agent của Wecommit · Giải pháp AI chuyển đổi số
          </p>
        </div>
      </div>
    </div>
  );
}

