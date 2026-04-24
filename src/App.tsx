/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import { GoogleGenAI } from "@google/genai";
import { 
  Brain, 
  Zap, 
  Search, 
  PenTool, 
  CheckCircle, 
  Send, 
  RotateCcw, 
  AlertCircle, 
  Check, 
  X,
  ChevronDown,
  ChevronUp,
  Loader2,
  Mail,
  RefreshCw
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

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
    "sentiment_label": "Excited | Anxious | Frustrated | Neutral | Professional | Urgent",
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

// ─── INITIALIZATION ───────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const modelName = "gemini-3-flash-preview";

async function callGemini(systemPrompt: string, userMessage: string) {
  try {
    const result = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: { 
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.2
      }
    });
    const text = result.text || "";
    
    // Improved robust JSON extraction
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    
    if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
      throw new Error("No valid JSON object found in response");
    }
    
    const jsonStr = text.substring(firstBrace, lastBrace + 1);
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Call Error:", error);
    // Return a dummy object so the flow doesn't crash, but log the error
    return { error: "Failed to fetch response", analysis_layer: { is_relevant: false, rejection_reason: "AI processing error" } };
  }
}

// ─── DATA & TYPES ─────────────────────────────────────────────────────────────

interface AgentMeta {
  label: string;
  icon: React.ElementType;
  color: string;
  bg: string;
  border: string;
}

const AGENT_META: Record<string, AgentMeta> = {
  emotion: { label: "Agent Cảm xúc", icon: Brain, color: "text-[#CCFF00]", bg: "bg-white/5", border: "border-white/10" },
  leader:  { label: "Agent Trưởng nhóm",  icon: Zap, color: "text-[#CCFF00]", bg: "bg-white/5", border: "border-white/10" },
  rag:     { label: "Agent Kiểm tra RAG", icon: Search, color: "text-[#CCFF00]", bg: "bg-white/5", border: "border-white/10" },
  writer:  { label: "Agent Biên soạn",  icon: PenTool, color: "text-[#FF3D00]", bg: "bg-white/5", border: "border-white/10" },
  qa:      { label: "Agent Kiểm định",      icon: CheckCircle, color: "text-[#CCFF00]", bg: "bg-white/5", border: "border-white/10" },
};

const STEP_LABELS = [
  { id: "emotion", step: 1, label: "Phân tích cảm xúc" },
  { id: "leader",  step: 2, label: "Điều phối luồng" },
  { id: "rag",     step: 3, label: "Tra cứu dữ liệu" },
  { id: "writer",  step: 4, label: "Soạn email draft" },
  { id: "qa",      step: 5, label: "Kiểm định chất lượng" },
];

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

interface AgentBadgeProps {
  id: string;
  active: boolean;
  done: boolean;
}

const AgentBadge: React.FC<AgentBadgeProps> = ({ id, active, done }) => {
  const m = AGENT_META[id];
  const Icon = m.icon;
  return (
    <motion.div 
      animate={{ scale: active ? 1.05 : 1 }}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all duration-300 ${
        done || active ? "glass border-[#CCFF00]/40" : "bg-white/5 border-white/10 opacity-30"
      }`}
    >
      <Icon className={`w-4 h-4 ${active || done ? "text-[#CCFF00]" : "text-white/40"}`} />
      <span className={`text-[10px] font-black tracking-tighter uppercase ${active || done ? "text-[#CCFF00]" : "text-white/40"}`}>
        {m.label}
      </span>
      {done && <Check className="w-3 h-3 text-[#CCFF00]" />}
      {active && <Loader2 className="w-3 h-3 text-[#CCFF00] animate-spin" />}
    </motion.div>
  );
};

interface AgentCardProps {
  id: string;
  data: any;
  isLoading: boolean;
}

const AgentCard: React.FC<AgentCardProps> = ({ id, data, isLoading }) => {
  const m = AGENT_META[id];
  const [open, setOpen] = useState(false);
  const Icon = m.icon;

  if (!data && !isLoading) return null;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass rounded-2xl border-white/10 overflow-hidden mb-3`}
    >
      <div
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-3 p-4 cursor-pointer transition-colors hover:bg-white/5`}
      >
        <div className={`p-2 rounded-lg bg-white/5 border border-white/10`}>
          <Icon className={`w-4 h-4 ${m.color}`} />
        </div>
        <span className={`font-display text-xs flex-1 ${m.color}`}>{m.label}</span>
        {isLoading ? (
          <div className="flex items-center gap-2">
            <span className={`text-[9px] font-black uppercase tracking-widest ${m.color}`}>Active</span>
            <Loader2 className={`w-3 h-3 ${m.color} animate-spin`} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={`text-[9px] font-black uppercase tracking-widest opacity-40`}>{open ? "Thu gọn" : "Mở rộng"}</span>
            {open ? <ChevronUp className={`w-3 h-3 opacity-40`} /> : <ChevronDown className={`w-3 h-3 opacity-40`} />}
          </div>
        )}
      </div>
      <AnimatePresence>
        {open && data && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden bg-black/40 border-t border-white/5"
          >
            <pre className="p-4 text-[10px] leading-relaxed text-white/60 whitespace-pre-wrap break-words font-mono">
              {JSON.stringify(data, null, 2)}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

interface ScoreBadgeProps {
  label: string;
  score: number;
}

const ScoreBadge: React.FC<ScoreBadgeProps> = ({ label, score }) => {
  const color = score >= 8 ? "bg-[#CCFF00] text-black" : score >= 6 ? "bg-white/20 text-white" : "bg-[#FF3D00] text-black";
  return (
    <div className="text-center group">
      <motion.div 
        whileHover={{ scale: 1.1, rotate: 5 }}
        className={`w-10 h-10 rounded-xl ${color} flex items-center justify-center font-display text-sm mx-auto mb-1.5 shadow-lg`}
      >
        {score}
      </motion.div>
      <div className="text-[8px] font-black text-white/40 uppercase tracking-widest">{label}</div>
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

export default function App() {
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
    if (logRef.current) {
      logRef.current.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [log]);

  const addLog = (agent: string, msg: string, type: string = "info") => {
    setLog(prev => [...prev, { agent, msg, type, ts: Date.now() }]);
  };

  const runFlow = async (userInput: string, writerContext: any = null) => {
    const currentIter = iterCount + 1;
    setIterCount(currentIter);
    setDoneAgents([]);
    setActiveAgent(null);
    setSkippedRag(false);

    addLog("system", `═══ Bắt đầu vòng lặp #${currentIter} ═══`, "system");

    // ── STEP 1: EMOTION AGENT ──
    setActiveAgent("emotion");
    addLog("emotion", "Đang phân tích ý định và cảm xúc...");
    const emotionResult = await callGemini(EMOTION_AGENT_SYSTEM, userInput);
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
    const leaderResult = await callGemini(
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
      ragResult = await callGemini(
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
    const writerVersion = writerContext ? writerContext.version : 1;
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
    const writerResult = await callGemini(
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
    const qaResult = await callGemini(
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
      // Prevent infinite loop if model keeps failing
      if (currentIter < 3) {
        await runFlow(userInput, {
          draft: writerResult,
          feedback: evaluation?.correction_guide,
          version: writerVersion + 1,
        });
      } else {
        addLog("system", "Cảnh báo: Đã vượt quá số lần sửa tự động. Chờ người dùng can thiệp.", "warn");
        setPhase("awaiting_approval");
      }
    } else {
      addLog("qa", "✓ QA PASSED! Chuyển cho người dùng duyệt.", "success");
      setPhase("awaiting_approval");
    }
  };

  const handleStart = async () => {
    if (!input.trim()) return;
    setPhase("running");
    setResults({});
    setLog([]);
    setIterCount(0);
    setFinalEmail(null);
    setFeedback("");
    await runFlow(input.trim());
  };

  const handleApprove = () => {
    const draft = results.writer?.production_layer;
    setFinalEmail(draft);
    setPhase("done");
    addLog("system", "✅ Người dùng đã DUYỆT. Luồng kết thúc thành công.", "success");
  };

  const handleReject = async () => {
    if (!feedback.trim()) return;
    addLog("system", `Người dùng YÊU CẦU SỬA: ${feedback}`, "warn");
    setPhase("running");
    const draft = results.writer;
    const currentVersion = draft?.production_layer?.version || 1;
    await runFlow(input.trim(), {
      draft,
      feedback: feedback.trim(),
      version: currentVersion + 1,
    });
    setFeedback("");
  };

  const draft = results.writer?.production_layer;
  const qaEval = results.qa?.evaluation_layer;
  const rejected = results.rejection;

  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-[#CCFF00]/30 selection:text-[#CCFF00] relative overflow-hidden">
      {/* BACKGROUND ACCENTS */}
      <div className="absolute -top-40 -left-40 w-[500px] h-[500px] bg-[#CCFF00] rounded-full blur-[200px] opacity-[0.07] pointer-events-none" />
      <div className="absolute top-1/2 -right-20 w-[400px] h-[400px] bg-[#FF3D00] rounded-full blur-[180px] opacity-[0.05] pointer-events-none" />

      <div className="max-w-6xl mx-auto px-6 py-12 md:py-20 relative z-10">
        
        {/* HEADER */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-end mb-16 gap-6">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
          >
            <div className="text-[10px] tracking-[0.4em] font-black text-[#CCFF00] mb-2 uppercase opacity-80">
              HỆ THỐNG MULTI-AGENT v.08
            </div>
            <h1 className="text-5xl md:text-6xl font-display leading-[0.85] text-white">
              TƯ VẤN<br /><span className="text-[#CCFF00]">AGENTIC</span>
            </h1>
          </motion.div>
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex flex-col items-end gap-2"
          >
            <div className="flex gap-4 items-center text-[10px] font-black tracking-widest text-white/40 uppercase">
              <span>Bản_phát_hành_ổn_định</span>
              <div className="w-1 h-1 rounded-full bg-[#CCFF00]" />
              <span>Wecommit_AI</span>
            </div>
            <div className="glass px-6 py-3 rounded-2xl flex items-center gap-4">
              <div className="w-2 h-2 rounded-full bg-[#CCFF00] animate-pulse" />
              <span className="text-xs font-black tracking-widest uppercase">Hệ thống đang hoạt động</span>
            </div>
          </motion.div>
        </header>

        {/* PIPELINE VISUALIZATION */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap gap-2 justify-center mb-16 p-8 glass rounded-[40px] shadow-2xl"
        >
          {STEP_LABELS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-4">
              <AgentBadge
                id={s.id}
                active={activeAgent === s.id}
                done={doneAgents.includes(s.id)}
              />
              {i < STEP_LABELS.length - 1 && (
                <div className="hidden sm:block text-white/10 font-display text-lg tracking-tighter">/</div>
              )}
            </div>
          ))}
        </motion.div>

        {/* MAIN LAYOUT */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* LEFT COLUMN: Input & Results */}
          <div className="lg:col-span-7 space-y-8">
            
            <AnimatePresence mode="wait">
              {phase === "idle" && (
                <motion.div 
                  key="idle"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-[#CCFF00] rounded-[50px] p-10 shadow-2xl relative overflow-hidden text-black"
                >
                  <div className="absolute top-0 right-0 p-12 text-[180px] font-display opacity-[0.05] leading-none pointer-events-none">
                    01
                  </div>
                  <h2 className="text-4xl font-display leading-[0.9] mb-8 break-words">
                    TƯ VẤN<br />MỚI
                  </h2>
                  <textarea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder="Mô tả yêu cầu khách hàng..."
                    className="w-full min-h-[180px] p-6 bg-black/5 border-2 border-black/10 rounded-[30px] text-black text-lg leading-relaxed placeholder:text-black/30 focus:border-black/30 focus:ring-0 transition-all resize-none font-bold"
                  />
                  <div className="mt-8 flex flex-wrap gap-3">
                    {[
                      "Lịch khai giảng khóa AI?",
                      "Học phí & Ưu đãi?",
                      "Hỗ trợ Mentors?",
                    ].map(ex => (
                      <button
                        key={ex}
                        onClick={() => setInput(ex)}
                        className="px-6 py-2.5 text-[10px] font-black rounded-full border-2 border-black/10 hover:bg-black hover:text-[#CCFF00] transition-all cursor-pointer uppercase tracking-widest"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={handleStart}
                    disabled={!input.trim()}
                    className={`group w-full mt-10 py-6 rounded-full font-display text-2xl transition-all flex items-center justify-center gap-4 ${
                      input.trim() 
                        ? "bg-black text-white shadow-2xl hover:scale-[1.02] active:scale-95" 
                        : "bg-black/10 text-black/20 cursor-not-allowed"
                    }`}
                  >
                    KHỞI CHẠY AGENTS
                    <Send className="w-6 h-6 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                  </button>
                </motion.div>
              )}

              {rejected && (
                <motion.div 
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-[#FF3D00] rounded-[40px] p-10 text-black shadow-2xl"
                >
                  <div className="flex items-start gap-6">
                    <div className="bg-black/10 p-4 rounded-3xl">
                      <AlertCircle className="w-10 h-10" />
                    </div>
                    <div>
                      <h3 className="font-display text-3xl leading-none mb-3 uppercase tracking-tighter">Lỗi_Từ_Chối</h3>
                      <p className="font-bold text-lg leading-snug">{rejected}</p>
                      <button 
                        onClick={() => { setPhase("idle"); setResults({}); setLog([]); }}
                        className="mt-6 px-10 py-4 bg-black text-[#FF3D00] rounded-full text-sm font-black tracking-widest uppercase hover:scale-105 transition"
                      >
                        Làm mới hệ thống
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {(phase === "running" || phase === "awaiting_approval" || phase === "done") && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between px-4">
                    <h3 className="font-display text-2xl tracking-tighter text-white">
                      THEO_DÕI_TIẾN_TRÌNH
                    </h3>
                    <div className="text-[10px] font-black tracking-[0.3em] text-[#CCFF00] uppercase">
                      Phiên_bản_lặp_v.{iterCount}
                    </div>
                  </div>
                  <div className="space-y-3">
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
                  </div>
                  {skippedRag && (
                    <div className="p-8 rounded-[40px] glass border-dashed border-white/20 text-white/30 text-center text-xs font-black uppercase tracking-[0.3em]">
                      Kích_hoạt_luồng_trực_tiếp • Không_cần_kiểm_tra_RAG
                    </div>
                  )}
                </div>
              )}
            </AnimatePresence>
          </div>

          {/* RIGHT COLUMN: Log, Drafts, QA */}
          <div className="lg:col-span-5 space-y-6">
            
            {/* LOG */}
            <div className="glass rounded-[40px] overflow-hidden flex flex-col shadow-2xl">
              <div className="px-6 py-5 border-b border-white/10 flex items-center justify-between bg-white/5 backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#CCFF00] animate-pulse shadow-[0_0_10px_#CCFF00]" />
                  <span className="text-[10px] font-black text-white/60 uppercase tracking-[0.2em]">Dòng_dữ_liệu_trực_tiếp</span>
                </div>
                <div className="flex gap-1">
                  <div className="w-1 h-1 rounded-full bg-white/40" />
                  <div className="w-3 h-1 rounded-full bg-[#CCFF00]" />
                </div>
              </div>
              <div ref={logRef} className="h-[280px] overflow-y-auto p-6 space-y-3 font-mono text-[10px] leading-relaxed custom-scrollbar">
                <AnimatePresence initial={false}>
                  {log.map((l, i) => {
                    const colors: any = { 
                      success: "text-[#CCFF00]", 
                      error: "text-[#FF3D00]", 
                      warn: "text-[#FF3D00] font-bold opacity-80", 
                      system: "text-white font-bold opacity-40", 
                      skip: "text-white/20 italic", 
                      info: "text-white/80" 
                    };
                    return (
                      <motion.div 
                        key={l.ts + i}
                        initial={{ opacity: 0, x: 5 }}
                        animate={{ opacity: 1, x: 0 }}
                        className={`${colors[l.type] || "text-white/80"} flex flex-col gap-0.5 border-l border-white/5 pl-3`}
                      >
                        <span className="text-[8px] uppercase tracking-widest opacity-30">
                          {new Date(l.ts).toLocaleTimeString()}
                        </span>
                        <span>{l.msg}</span>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </div>

            {/* QA ANALYSIS */}
            {qaEval && (
              <motion.div 
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className={`glass rounded-[40px] p-8 shadow-2xl relative overflow-hidden`}
              >
                <div className="flex items-center justify-between mb-8">
                   <div>
                    <h4 className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em] mb-1">Kiểm_định_module</h4>
                    <div className="font-display text-2xl tracking-tighter text-white">VỆ_BINH_CHẤT_LƯỢNG</div>
                   </div>
                   <div className={`px-5 py-2 rounded-full text-[10px] font-black uppercase tracking-widest ${
                     qaEval.status === "PASS" ? "bg-[#CCFF00] text-black" : "bg-[#FF3D00] text-black"
                   }`}>
                     {qaEval.status === "PASS" ? "ĐẠT" : "KHÔNG ĐẠT"}
                   </div>
                </div>
                
                {qaEval.scores && (
                  <div className="grid grid-cols-5 gap-3 mb-8">
                    {Object.entries(qaEval.scores).map(([k, v]: [string, any]) => (
                      <ScoreBadge key={k} label={k.split('_')[0]} score={v} />
                    ))}
                  </div>
                )}

                {qaEval.correction_guide && (
                  <div className="bg-[#FF3D00]/10 rounded-2xl p-5 border border-[#FF3D00]/20">
                    <p className="text-[10px] font-black text-[#FF3D00] uppercase tracking-widest mb-2 flex items-center gap-2">
                       <AlertCircle className="w-3 h-3" /> Chỉ_thị_hệ_thống
                    </p>
                    <p className="text-xs font-bold text-white/90 leading-normal">
                      {qaEval.correction_guide}
                    </p>
                  </div>
                )}
              </motion.div>
            )}

            {/* DRAFT PREVIEW */}
            {(phase === "awaiting_approval" || phase === "done") && draft && (
              <motion.div 
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className={`rounded-[50px] overflow-hidden shadow-[0_30px_100px_rgba(0,0,0,0.5)] border-t-[12px] ${
                  phase === "done" ? "bg-white text-black border-[#CCFF00]" : "bg-white text-black border-[#FF3D00]"
                }`}
              >
                <div className="p-10">
                  <div className="flex justify-between items-start mb-8">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black tracking-widest opacity-40 uppercase mb-2">Giao_diện_tiêu_đề</span>
                      <h4 className="font-display text-2xl leading-none">{draft.subject}</h4>
                    </div>
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${phase === 'done' ? 'bg-[#CCFF00]' : 'bg-[#FF3D00]'}`}>
                       {phase === 'done' ? <CheckCircle className="w-8 h-8" /> : <Mail className="w-8 h-8" />}
                    </div>
                  </div>
                  
                  <div className="bg-black/5 rounded-[30px] p-8 text-black text-base leading-relaxed font-semibold h-[320px] overflow-y-auto custom-scrollbar mb-8">
                    {draft.current_draft.split('\n').map((line: string, i: number) => (
                      <p key={i} className="mb-4">{line}</p>
                    ))}
                  </div>

                  {phase === "awaiting_approval" && (
                    <div className="space-y-6">
                      <button 
                        onClick={handleApprove}
                        className="w-full py-6 bg-black text-white rounded-full font-display text-2xl flex items-center justify-center gap-4 hover:scale-[1.02] active:scale-95 transition-all shadow-2xl"
                      >
                        PHÁT_HÀNH_KẾT_QUẢ <Check className="w-6 h-6 text-[#CCFF00]" />
                      </button>

                      <div className="space-y-3">
                        <textarea
                          value={feedback}
                          onChange={e => setFeedback(e.target.value)}
                          placeholder="YÊU_CẦU_CHỈNH_SỬA..."
                          className="w-full h-24 p-5 text-sm bg-black/5 border-2 border-black/10 rounded-3xl focus:border-black/20 transition-all resize-none font-bold placeholder:opacity-30"
                        />
                        <button 
                          onClick={handleReject}
                          disabled={!feedback.trim()}
                          className={`w-full py-4 rounded-full font-black text-xs tracking-[0.2em] uppercase flex items-center justify-center gap-2 transition-all ${
                            feedback.trim() 
                              ? "bg-[#FF3D00] text-black" 
                              : "bg-black/5 text-black/20"
                          }`}
                        >
                          <RotateCcw className="w-4 h-4" /> TRUY_VẾT_VÀ_CẬP_NHẬT
                        </button>
                      </div>
                    </div>
                  )}

                  {phase === "done" && (
                    <button 
                      onClick={() => { setPhase("idle"); setResults({}); setLog([]); setInput(""); setFinalEmail(null); }}
                      className="w-full py-6 bg-black text-[#CCFF00] rounded-full font-display text-2xl flex items-center justify-center gap-4 hover:scale-[1.02] transition-all"
                    >
                      <RefreshCw className="w-6 h-6 animate-spin" /> LUỒNG_MỚI
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </div>
        </div>

        {/* FOOTER */}
        <footer className="mt-20 pt-10 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="text-[10px] font-black tracking-[0.4em] text-white/20 uppercase flex gap-8">
            <span>© 2026 Wecommit_Labs</span>
            <span>BẢN_ỔN_ĐỊNH</span>
          </div>
          <div className="flex gap-6 text-[10px] font-black tracking-widest text-[#CCFF00] uppercase">
            <span>Vĩ độ: 21.0285</span>
            <span>Kinh độ: 105.8544</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
