// 内置实验 Protocol 模板库
// 每个模板定义：参数表单字段 + 试剂表 + 步骤生成逻辑

export const TEMPLATES = [
  {
    id: "pcr",
    name: "PCR 扩增",
    desc: "聚合酶链式反应，用于 DNA 片段扩增",
    icon: "🧬",
    color: "#0d7d6c",
    bg: "#e6f4f1",
    fields: [
      { key: "targetGene", label: "目标基因/片段", type: "text", placeholder: "如 EGFR exon 19", required: true },
      { key: "templateType", label: "模板类型", type: "select", options: ["基因组 DNA", "cDNA", "质粒 DNA", "PCR 产物"] },
      { key: "templateConc", label: "模板浓度 (ng/μL)", type: "number", default: 50, min: 0.1, step: 0.1 },
      { key: "primerF", label: "正向引物序列 (5'→3')", type: "text", placeholder: "ATCGATCG...", mono: true },
      { key: "primerR", label: "反向引物序列 (5'→3')", type: "text", placeholder: "GCTAGCTA...", mono: true },
      { key: "primerTm", label: "引物 Tm (°C)", type: "number", default: 60, min: 45, max: 80 },
      { key: "productSize", label: "预期产物大小 (bp)", type: "number", default: 500, min: 50 },
      { key: "polymerase", label: "聚合酶", type: "select", options: ["Taq DNA Polymerase", "Q5 High-Fidelity", "KAPA HiFi", "Phusion", "Taq 混合酶 (含染料)"] },
      { key: "totalVolume", label: "反应总体积 (μL)", type: "number", default: 25, options: [10, 20, 25, 50] },
      { key: "cycles", label: "循环数", type: "number", default: 30, min: 20, max: 40 },
      { key: "annealTemp", label: "退火温度 (°C)", type: "number", default: 58, min: 45, max: 72, hint: "通常 Tm − 3~5°C" },
      { key: "extendTime", label: "延伸时间 (s)", type: "number", default: 30, hint: "约 1 min/kb (Taq) 或 30 s/kb (Q5)" },
    ],
    reagents(v) {
      const vol = v.totalVolume || 25;
      const isMaster = /Q5|KAPA|Phusion/.test(v.polymerase || "");
      const rows = [
        ["2× Master Mix / Buffer", isMaster ? `${(vol * 0.5).toFixed(1)} μL` : `${(vol * 0.1).toFixed(1)} μL (10× Buffer)`],
        ["正向引物 (10 μM)", `${(vol * 0.02).toFixed(1)} μL`],
        ["反向引物 (10 μM)", `${(vol * 0.02).toFixed(1)} μL`],
        ["模板 DNA", `${Math.min(2, Math.max(0.5, (vol * 0.04))).toFixed(1)} μL`],
        ["dNTPs (10 mM, 非 Master Mix)", isMaster ? "—" : `${(vol * 0.02).toFixed(1)} μL`],
        ["聚合酶", isMaster ? "已含" : `${(vol * 0.01).toFixed(1)} μL (0.5 U)`],
        ["ddH₂O", `补足至 ${vol} μL`],
      ];
      return rows;
    },
    steps(v) {
      const at = v.annealTemp || 58;
      const ext = v.extendTime || 30;
      const cyc = v.cycles || 30;
      const isHiFi = /Q5|KAPA|Phusion/.test(v.polymerase || "");
      const denat = isHiFi ? "98°C" : "94°C";
      return [
        { h: "反应体系配制", items: [
          `在冰上按试剂表依次加入各组分，总体积 ${v.totalVolume || 25} μL`,
          "轻柔吹打混匀 5~8 次，避免产生气泡",
          "瞬时离心 (3~5 s) 将液体收集至管底",
        ]},
        { h: "PCR 循环程序", items: [
          `预变性：${denat}，3 min（激活热启动酶 / 充分变性模板）`,
          `循环（${cyc} 个循环）：`,
          `  ① 变性：${denat}，15~30 s`,
          `  ② 退火：${at}°C，15~30 s`,
          `  ③ 延伸：72°C，${ext} s`,
          `终延伸：72°C，5 min`,
          `保存：4°C，∞`,
        ]},
        { h: "产物检测", items: [
          "取 3~5 μL 产物进行琼脂糖凝胶电泳（1~2% 胶，120 V，20~25 min）",
          `预期条带大小：${v.productSize || 500} bp`,
          "使用 DNA Marker 对照，凝胶成像系统观察并记录",
        ]},
      ];
    },
    notes(v) {
      const notes = [];
      if ((v.primerTm || 60) < 55) notes.push({ type: "warning", text: "引物 Tm 偏低 (<55°C)，可能出现非特异性扩增，建议重新设计引物。" });
      if ((v.cycles || 30) > 35) notes.push({ type: "warning", text: "循环数 >35 会增加非特异性产物和突变风险，建议优化模板量后减少循环数。" });
      notes.push({ type: "note", text: "配制体系时最后加入模板 DNA 和聚合酶，减少非特异性扩增。" });
      notes.push({ type: "note", text: "设置阴性对照（无模板）和阳性对照，排除污染和验证体系有效性。" });
      if (/Q5|KAPA|Phusion/.test(v.polymerase || "")) {
        notes.push({ type: "note", text: "高保真酶延伸速度快（~30 s/kb），GC 含量高时可添加 DMSO 或 GC enhancer。" });
      }
      return notes;
    },
  },

  {
    id: "western-blot",
    name: "Western Blot",
    desc: "蛋白质免疫印迹，检测特定蛋白表达",
    icon: "🔬",
    color: "#5b4bb7",
    bg: "#eeeafb",
    fields: [
      { key: "targetProtein", label: "目标蛋白", type: "text", placeholder: "如 p53, GAPDH", required: true },
      { key: "proteinMW", label: "蛋白分子量 (kDa)", type: "number", default: 53, min: 5 },
      { key: "sampleType", label: "样品类型", type: "select", options: ["细胞裂解液", "组织匀浆", "纯化蛋白", "血清/血浆"] },
      { key: "sampleConc", label: "样品蛋白浓度 (μg/μL)", type: "number", default: 2, min: 0.1, step: 0.1 },
      { key: "loadAmount", label: "每孔上样量 (μg)", type: "number", default: 20, min: 5, max: 100 },
      { key: "gelPercent", label: "分离胶浓度 (%)", type: "number", default: 10, options: [7.5, 8, 10, 12, 15], hint: "小蛋白用高浓度胶" },
      { key: "primaryAb", label: "一抗", type: "text", placeholder: "如 anti-p53 (Cell Signaling #2524)" },
      { key: "primaryDilution", label: "一抗稀释比", type: "text", default: "1:1000", placeholder: "1:1000" },
      { key: "secondaryAb", label: "二抗", type: "select", options: ["Goat anti-Rabbit HRP", "Goat anti-Mouse HRP", "Donkey anti-Rabbit HRP", "Donkey anti-Mouse HRP"] },
      { key: "secondaryDilution", label: "二抗稀释比", type: "text", default: "1:5000" },
      { key: "transferTime", label: "转膜时间 (min)", type: "number", default: 90, hint: "湿转 100V；半干转 15~25 min" },
      { key: "transferMethod", label: "转膜方式", type: "select", options: ["湿转 (100V)", "半干转 (25V)", "iBlot 干转"] },
    ],
    reagents(v) {
      const wells = 10;
      const load = v.loadAmount || 20;
      const conc = v.sampleConc || 2;
      const volPerWell = (load / conc).toFixed(1);
      return [
        ["蛋白样品", `${volPerWell} μL/孔 (${load} μg)`],
        ["5× Loading Buffer", `${(volPerWell / 4).toFixed(1)} μL/孔`],
        ["预制胶 / 自配胶", `${v.gelPercent || 10}% 分离胶, 5% 浓缩胶`],
        ["电泳缓冲液 (1×)", "~800 mL (Tris-Glycine-SDS)"],
        ["转膜缓冲液 (1×)", "~1 L (含 20% 甲醇)"],
        ["PVDF / NC 膜", `1 张 (预激活: 甲醇浸泡 PVDF 1 min)`],
        ["封闭液", "5% 脱脂奶粉/TBST 或 BSA, 10~15 mL"],
        ["一抗", `${v.primaryDilution || "1:1000"} 稀释, 5~10 mL`],
        ["二抗", `${v.secondaryDilution || "1:5000"} 稀释, 5~10 mL`],
        ["ECL 显色液", "A:B = 1:1, 1~2 mL"],
        ["TBST 洗膜液", "3 × 10 min, 每次 ~15 mL"],
      ];
    },
    steps(v) {
      const mw = v.proteinMW || 53;
      const gel = v.gelPercent || 10;
      return [
        { h: "样品制备", items: [
          `取蛋白样品，按每孔 ${v.loadAmount || 20} μg 计算体积`,
          "加入 5× Loading Buffer（终浓度 1×），混匀",
          "100°C 金属浴加热 5~10 min 使蛋白变性",
          "瞬时离心后置于冰上待用",
        ]},
        { h: "SDS-PAGE 电泳", items: [
          `配制/使用 ${gel}% 分离胶 + 5% 浓缩胶`,
          "上样：Marker 孔 + 样品孔（每孔等量）",
          "浓缩胶 80 V 约 30 min，分离胶 120 V 约 60~90 min",
          `电泳至溴酚蓝到达胶底部（${mw} kDa 蛋白约需分离至胶的 2/3 处）`,
        ]},
        { h: "转膜", items: [
          "PVDF 膜甲醇激活 1 min → 转膜缓冲液平衡 5 min",
          "按 凝胶-膜 顺序组装三明治（驱除气泡）",
          `${v.transferMethod || "湿转 (100V)"}，转膜 ${v.transferTime || 90} min（冰浴）`,
          "转膜后丽春红染色验证转膜效率（可选）",
        ]},
        { h: "封闭与抗体孵育", items: [
          "5% 脱脂奶粉/TBST 室温封闭 1 h（或 4°C 过夜）",
          `一抗 ${v.primaryDilution || "1:1000"} 稀释，4°C 摇床孵育过夜（或室温 2 h）`,
          "TBST 洗膜 3 × 10 min",
          `二抗 ${v.secondaryDilution || "1:5000"} 稀释，室温摇床孵育 1 h`,
          "TBST 洗膜 3 × 10 min",
        ]},
        { h: "显色与成像", items: [
          "ECL A:B = 1:1 混合，均匀滴加至膜上，反应 1~3 min",
          "化学发光成像系统曝光，调整曝光时间获取最佳信噪比",
          "记录图像，使用 ImageJ 进行灰度分析（如需定量）",
        ]},
      ];
    },
    notes(v) {
      const notes = [];
      const mw = v.proteinMW || 53;
      if (mw < 20) notes.push({ type: "note", text: `目标蛋白 ${mw} kDa 较小，建议使用 12~15% 分离胶，转膜时间缩短至 45~60 min。` });
      if (mw > 150) notes.push({ type: "note", text: `目标蛋白 ${mw} kDa 较大，建议使用 7.5~8% 分离胶，转膜时间延长至 120 min 或使用半干转。` });
      notes.push({ type: "note", text: "磷酸化抗体检测时，封闭液使用 BSA 而非脱脂奶粉（奶粉含磷酸酶）。" });
      notes.push({ type: "warning", text: "ECL 显色液避光操作，A/B 液混合后 5 min 内使用。" });
      return notes;
    },
  },

  {
    id: "cell-passage",
    name: "细胞传代培养",
    desc: "贴壁细胞消化传代标准流程",
    icon: "🦠",
    color: "#b47a12",
    bg: "#fdf3e0",
    fields: [
      { key: "cellLine", label: "细胞系", type: "text", placeholder: "如 HeLa, HEK293T, MCF-7", required: true },
      { key: "cultureVessel", label: "培养容器", type: "select", options: ["T25 培养瓶", "T75 培养瓶", "6 孔板", "12 孔板", "10 cm 培养皿", "15 cm 培养皿"] },
      { key: "medium", label: "完全培养基", type: "select", options: ["DMEM + 10% FBS + 1% P/S", "RPMI 1640 + 10% FBS + 1% P/S", "DMEM/F12 + 10% FBS", "MEM + 10% FBS + 1% P/S", "自定义"] },
      { key: "customMedium", label: "自定义培养基配方", type: "text", placeholder: "仅在选择'自定义'时填写" },
      { key: "splitRatio", label: "传代比例", type: "select", options: ["1:2", "1:3", "1:4", "1:5", "1:6", "1:10"] },
      { key: "trypsinTime", label: "胰酶消化时间 (min)", type: "number", default: 2, min: 0.5, max: 10, step: 0.5, hint: "37°C 下，镜下观察细胞回缩变圆" },
      { key: "passageNo", label: "当前代数 (P#)", type: "number", default: 5, min: 1 },
      { key: "confluency", label: "当前汇合度 (%)", type: "number", default: 85, min: 30, max: 100, hint: "建议 80~90% 时传代" },
    ],
    reagents(v) {
      const vessel = v.cultureVessel || "T75 培养瓶";
      const volMap = { "T25 培养瓶": "5~6 mL", "T75 培养瓶": "10~15 mL", "6 孔板": "2 mL/孔", "12 孔板": "1 mL/孔", "10 cm 培养皿": "10 mL", "15 cm 培养皿": "20 mL" };
      return [
        ["完全培养基", volMap[vessel] || "10 mL"],
        ["PBS (无 Ca²⁺/Mg²⁺)", "5~10 mL（润洗）"],
        ["0.25% Trypsin-EDTA", "1~2 mL"],
        ["胎牛血清 (FBS)", "培养基终浓度 10%"],
        ["青霉素-链霉素 (P/S)", "培养基终浓度 1%"],
        ["新培养容器", `${vessel} × ${(v.splitRatio || "1:3").split(":")[1]}`],
      ];
    },
    steps(v) {
      const ratio = v.splitRatio || "1:3";
      const n = ratio.split(":")[1] || "3";
      return [
        { h: "传代前准备", items: [
          "生物安全柜紫外照射 30 min，75% 酒精擦拭台面",
          "预热完全培养基、PBS、胰酶至 37°C 水浴",
          `镜下观察细胞状态：汇合度约 ${v.confluency || 85}%，形态正常、无污染`,
        ]},
        { h: "消化传代", items: [
          "弃去旧培养基（沿瓶壁缓慢吸出）",
          "PBS 5~10 mL 轻柔润洗 1 次，去除残留血清",
          "加入 0.25% Trypsin-EDTA 1~2 mL（覆盖瓶底即可）",
          `37°C 孵箱消化 ${v.trypsinTime || 2} min，镜下观察细胞回缩变圆、间隙增大`,
          "加入 2~3 倍体积含血清培养基终止消化",
          "轻柔吹打瓶底使细胞完全脱落，收集至离心管",
          "1000 rpm 离心 5 min，弃上清",
          `重悬于新鲜培养基，按 ${ratio} 分至 ${n} 个新容器`,
          "十字交叉轻柔混匀，37°C / 5% CO₂ 孵箱培养",
        ]},
        { h: "传代后记录", items: [
          `标记：细胞系 ${v.cellLine || "___"}，P${(v.passageNo || 5) + 1}，日期，操作人`,
          "次日镜下观察贴壁情况，2~3 天后换液",
          "达到 80~90% 汇合度时进行下一次传代",
        ]},
      ];
    },
    notes(v) {
      const notes = [];
      notes.push({ type: "warning", text: "严格无菌操作：所有试剂、耗材需灭菌，操作全程在生物安全柜内进行。" });
      notes.push({ type: "note", text: "消化时间因细胞系而异，首次操作建议镜下实时观察，避免过度消化损伤细胞。" });
      if ((v.confluency || 85) > 95) notes.push({ type: "warning", text: "汇合度过高（>95%）细胞可能进入接触抑制，建议 80~90% 时传代。" });
      if ((v.passageNo || 5) > 30) notes.push({ type: "warning", text: `当前代数 P${v.passageNo}，代次过高可能出现遗传漂变，建议复苏低代次冻存管。` });
      notes.push({ type: "note", text: "定期检测支原体污染（每 2~4 周），尤其是长期培养的细胞系。" });
      return notes;
    },
  },

  {
    id: "plasmid-prep",
    name: "质粒小量提取",
    desc: "碱裂解法从大肠杆菌中提取质粒 DNA",
    icon: "🧪",
    color: "#2563a8",
    bg: "#e8f1fa",
    fields: [
      { key: "plasmidName", label: "质粒名称", type: "text", placeholder: "如 pET-28a-GFP", required: true },
      { key: "hostStrain", label: "宿主菌", type: "select", options: ["DH5α", "TOP10", "BL21(DE3)", "JM109", "Stbl3", "其他"] },
      { key: "antibiotic", label: "抗性筛选", type: "select", options: ["Ampicillin (100 μg/mL)", "Kanamycin (50 μg/mL)", "Chloramphenicol (34 μg/mL)", "Spectinomycin (50 μg/mL)", "Carbenicillin (50 μg/mL)"] },
      { key: "cultureVolume", label: "培养体积 (mL)", type: "number", default: 5, options: [3, 5, 10] },
      { key: "copyNumber", label: "质粒拷贝数", type: "select", options: ["高拷贝 (pUC ori)", "中拷贝", "低拷贝 (pSC101 ori)"] },
      { key: "kitType", label: "提取方式", type: "select", options: ["试剂盒 (离心柱法)", "传统碱裂解法"] },
    ],
    reagents(v) {
      const isKit = (v.kitType || "试剂盒 (离心柱法)").includes("试剂盒");
      if (isKit) {
        return [
          ["过夜菌液", `${v.cultureVolume || 5} mL`],
          ["Solution I (Resuspension)", "250 μL"],
          ["Solution II (Lysis)", "250 μL"],
          ["Solution III (Neutralization)", "350 μL"],
          ["Wash Buffer (含乙醇)", "500 μL × 2"],
          ["Elution Buffer / ddH₂O", "30~50 μL"],
          ["离心柱 + 收集管", "1 套"],
        ];
      }
      return [
        ["过夜菌液", `${v.cultureVolume || 5} mL`],
        ["Solution I (50 mM Glucose, 25 mM Tris, 10 mM EDTA)", "100 μL"],
        ["Solution II (0.2 N NaOH, 1% SDS)", "200 μL（现配现用）"],
        ["Solution III (3 M KAc, pH 5.5)", "150 μL"],
        ["异丙醇", "等体积沉淀"],
        ["70% 乙醇", "500 μL 洗涤"],
        ["TE / ddH₂O", "30~50 μL 溶解"],
        ["RNase A (10 mg/mL)", "1 μL（加入 Solution I）"],
      ];
    },
    steps(v) {
      const isKit = (v.kitType || "试剂盒 (离心柱法)").includes("试剂盒");
      const vol = v.cultureVolume || 5;
      const steps1 = [
        { h: "菌体收集", items: [
          `取 ${vol} mL 过夜菌液（${v.antibiotic || "Ampicillin"} 抗性 LB，37°C 摇菌 12~16 h）`,
          "12,000 rpm 离心 1 min，弃上清",
          "重复离心收集全部菌体（如体积 >5 mL 分次离心）",
        ]},
      ];
      const steps2 = isKit ? [
        { h: "裂解与中和（离心柱法）", items: [
          "加入 250 μL Solution I（含 RNase A），充分重悬菌体至无颗粒",
          "加入 250 μL Solution II，轻柔颠倒 4~6 次混匀（勿剧烈振荡），室温 2 min",
          "溶液变澄清粘稠呈蓝色 → 加入 350 μL Solution III，立即颠倒混匀 6~8 次",
          "出现白色絮状沉淀，室温静置 5 min",
          "13,000 rpm 离心 10 min，小心吸取上清至离心柱",
          "12,000 rpm 离心 1 min，弃滤液",
        ]},
        { h: "洗涤与洗脱", items: [
          "加入 500 μL Wash Buffer，12,000 rpm 离心 1 min，弃滤液",
          "重复洗涤 1 次",
          "空柱 13,000 rpm 离心 2 min，彻底去除残留乙醇",
          "将柱转移至新离心管，加入 30~50 μL Elution Buffer（预热至 60°C 可提高产量）",
          "室温静置 2 min，13,000 rpm 离心 2 min，收集质粒 DNA",
        ]},
      ] : [
        { h: "碱裂解", items: [
          "加入 100 μL Solution I（含 RNase A），涡旋重悬至均匀",
          "加入 200 μL Solution II（现配），轻柔颠倒 4~6 次，室温 ≤5 min",
          "溶液变澄清粘稠 → 加入 150 μL Solution III，颠倒混匀，冰上 10 min",
          "13,000 rpm 离心 15 min（4°C），吸取上清至新管",
        ]},
        { h: "沉淀与纯化", items: [
          "加入等体积异丙醇，颠倒混匀，室温 10 min",
          "13,000 rpm 离心 15 min，弃上清（可见白色 DNA 沉淀）",
          "70% 乙醇 500 μL 洗涤沉淀，13,000 rpm 离心 5 min",
          "弃乙醇，室温晾干 5~10 min（勿完全干燥）",
          "30~50 μL TE 或 ddH₂O 溶解沉淀，65°C 助溶 5 min（可选）",
        ]},
      ];
      const steps3 = [
        { h: "质量检测", items: [
          "NanoDrop 测定浓度和纯度：A260/A280 = 1.8~1.9，A260/A230 > 2.0",
          `预期产量：${(v.copyNumber || "高拷贝 (pUC ori)").includes("高") ? "50~200 μg" : "5~20 μg"}（${vol} mL 菌液）`,
          "1% 琼脂糖凝胶电泳验证：超螺旋为主带，无明显基因组 DNA 拖尾",
          "−20°C 保存，长期 −80°C",
        ]},
      ];
      return [...steps1, ...steps2, ...steps3];
    },
    notes(v) {
      const notes = [];
      notes.push({ type: "warning", text: "Solution II 裂解时间严格控制在 5 min 以内，过度裂解释放基因组 DNA 会污染质粒。" });
      notes.push({ type: "note", text: "加入 Solution II 和 III 后仅轻柔颠倒混匀，剧烈振荡会剪切基因组 DNA。" });
      if ((v.copyNumber || "").includes("低")) notes.push({ type: "note", text: "低拷贝质粒产量较低，可增加培养体积至 10 mL 或使用 Rich Medium (TB)。" });
      notes.push({ type: "note", text: "A260/A280 < 1.7 提示蛋白污染，可重复酚氯仿抽提或柱纯化。" });
      return notes;
    },
  },

  {
    id: "elisa",
    name: "ELISA 检测",
    desc: "酶联免疫吸附测定，定量检测蛋白/抗体",
    icon: "📊",
    color: "#b3384d",
    bg: "#fdeaee",
    fields: [
      { key: "analyte", label: "检测目标", type: "text", placeholder: "如 IL-6, TNF-α, 特异性抗体", required: true },
      { key: "elisaType", label: "ELISA 类型", type: "select", options: ["间接法 (Indirect)", "夹心法 (Sandwich)", "竞争法 (Competitive)"] },
      { key: "sampleType", label: "样品类型", type: "select", options: ["血清", "血浆", "细胞培养上清", "组织匀浆", "纯化蛋白"] },
      { key: "sampleDilution", label: "样品稀释倍数", type: "text", default: "1:10", placeholder: "1:10, 1:100..." },
      { key: "standardRange", label: "标准品范围", type: "text", placeholder: "如 0~500 pg/mL" },
      { key: "standardPoints", label: "标准品梯度点数", type: "number", default: 8, min: 5, max: 12 },
      { key: "captureAb", label: "包被抗体", type: "text", placeholder: "如 anti-human IL-6 (clone MQ2-13A5)" },
      { key: "detectAb", label: "检测抗体", type: "text", placeholder: "如 Biotin-anti-human IL-6" },
      { key: "replicates", label: "复孔数", type: "number", default: 3, min: 2, max: 6 },
      { key: "incubationTime", label: "样品孵育时间", type: "select", options: ["室温 2 h", "37°C 1 h", "4°C 过夜"] },
    ],
    reagents(v) {
      const reps = v.replicates || 3;
      const pts = v.standardPoints || 8;
      return [
        ["96 孔酶标板 (高结合力)", "1 块"],
        ["包被抗体", `${v.captureAb || "___"}，1~2 μg/mL in Coating Buffer`],
        ["封闭液", "1% BSA/PBS 或 5% 脱脂奶粉/PBS，200 μL/孔`"],
        ["标准品", `${v.analyte || "___"}，${v.standardRange || "___"}，${pts} 个梯度`],
        ["样品", `${v.sampleType || "___"}，${v.sampleDilution || "1:10"} 稀释，${reps} 复孔`],
        ["检测抗体", `${v.detectAb || "___"}，工作浓度按说明书`],
        ["HRP-Streptavidin / 酶标二抗", "工作浓度稀释"],
        ["TMB 显色液", "100 μL/孔"],
        ["终止液 (2 M H₂SO₄)", "50 μL/孔"],
        ["PBS-T (0.05% Tween-20)", "洗板 300 μL/孔 × 4~5 次"],
      ];
    },
    steps(v) {
      const isSandwich = (v.elisaType || "").includes("夹心");
      const reps = v.replicates || 3;
      const pts = v.standardPoints || 8;
      const base = [
        { h: "包被（如自包被）", items: [
          `包被抗体 ${v.captureAb || "___"} 稀释至 1~2 μg/mL（Coating Buffer: 0.05 M NaHCO₃ pH 9.6）`,
          "每孔加入 100 μL，4°C 过夜或 37°C 2 h",
          "弃包被液，PBS-T 洗板 3 次（300 μL/孔）",
        ]},
        { h: "封闭", items: [
          "每孔加入 200 μL 封闭液（1% BSA/PBS）",
          "37°C 孵育 1~2 h 或室温 2 h",
          "弃封闭液，拍干（不洗板）",
        ]},
      ];
      const sample = [
        { h: "加样", items: [
          `标准品：${pts} 个梯度，每孔 100 μL，${reps} 复孔`,
          `样品：${v.sampleDilution || "1:10"} 稀释后每孔 100 μL，${reps} 复孔`,
          "设置空白对照（仅稀释液）",
          `${v.incubationTime || "室温 2 h"} 孵育`,
          "PBS-T 洗板 4~5 次，拍干",
        ]},
      ];
      const detect = isSandwich ? [
        { h: "检测抗体孵育", items: [
          `加入检测抗体 ${v.detectAb || "___"}（工作浓度），100 μL/孔`,
          "37°C 1 h 或室温 2 h",
          "PBS-T 洗板 4~5 次",
          "加入 HRP-Streptavidin（工作浓度），100 μL/孔，37°C 30 min",
          "PBS-T 洗板 4~5 次",
        ]},
      ] : [
        { h: "二抗孵育", items: [
          "加入酶标二抗（HRP 标记，工作浓度），100 μL/孔",
          "37°C 1 h 或室温 2 h",
          "PBS-T 洗板 4~5 次，拍干",
        ]},
      ];
      const develop = [
        { h: "显色与读数", items: [
          "每孔加入 100 μL TMB 显色液，避光室温 10~20 min",
          "观察标准品梯度呈蓝色，空白孔无色",
          "每孔加入 50 μL 终止液（2 M H₂SO₄），蓝色变黄色",
          "酶标仪 450 nm 读数（参考波长 570 nm 校正）",
          "30 min 内完成读数",
        ]},
        { h: "数据分析", items: [
          "以标准品浓度为 X 轴，OD450 为 Y 轴绘制标准曲线",
          "使用 4-Parameter Logistic (4PL) 拟合",
          "根据样品 OD 值从标准曲线计算浓度，乘以稀释倍数",
          `复孔 CV% 应 < 15%（${reps} 复孔取均值）`,
        ]},
      ];
      return [...base, ...sample, ...detect, ...develop];
    },
    notes(v) {
      const notes = [];
      notes.push({ type: "note", text: "洗板是 ELISA 关键步骤：每次洗板后拍干残留液体，减少背景信号。" });
      notes.push({ type: "note", text: "TMB 显色时间需根据标准品梯度调整，避免高浓度孔过饱和（OD > 3.0）。" });
      notes.push({ type: "warning", text: "终止液为强酸，操作时佩戴手套和护目镜。" });
      if ((v.elisaType || "").includes("夹心")) notes.push({ type: "note", text: "夹心法需确保包被抗体和检测抗体识别不同表位，避免竞争。" });
      notes.push({ type: "note", text: "样品避免反复冻融（≤3 次），血清/血浆需离心去除纤维蛋白。" });
      return notes;
    },
  },

  {
    id: "rna-extraction",
    name: "RNA 提取 (TRIzol)",
    desc: "TRIzol/氯仿法提取总 RNA",
    icon: "🧫",
    color: "#0d7d6c",
    bg: "#e6f4f1",
    fields: [
      { key: "sampleSource", label: "样品来源", type: "select", options: ["培养细胞", "动物组织", "植物组织", "血液", "细菌"] },
      { key: "sampleAmount", label: "样品量", type: "text", placeholder: "如 1×10⁶ 细胞 / 50 mg 组织", required: true },
      { key: "trizolVolume", label: "TRIzol 用量 (mL)", type: "number", default: 1, min: 0.5, step: 0.5 },
      { key: "dnase", label: "DNase I 处理", type: "select", options: ["是（柱上消化）", "是（溶液消化）", "否"] },
      { key: "downstream", label: "下游应用", type: "select", options: ["RT-qPCR", "RNA-seq", "Northern Blot", "体外翻译", "cDNA 文库构建"] },
    ],
    reagents(v) {
      const vol = v.trizolVolume || 1;
      return [
        ["TRIzol Reagent", `${vol} mL`],
        ["氯仿 (Chloroform)", `${(vol * 0.2).toFixed(1)} mL`],
        ["异丙醇", `${(vol * 0.5).toFixed(1)} mL`],
        ["75% 乙醇 (DEPC 水配制)", `${vol} mL`],
        ["DEPC 水 / RNase-free H₂O", "30~50 μL"],
        ["无水乙醇", "适量（清洗台面/器具）"],
        ...(v.dnase !== "否" ? [["DNase I (RNase-free)", "1 μL + Buffer"]] : []),
      ];
    },
    steps(v) {
      return [
        { h: "样品裂解", items: [
          `${v.sampleSource || "样品"}：加入 ${v.trizolVolume || 1} mL TRIzol`,
          v.sampleSource === "动物组织" || v.sampleSource === "植物组织"
            ? "组织匀浆器研磨/匀浆至完全裂解（冰上操作）"
            : "反复吹打至完全裂解，无可见团块",
          "室温静置 5 min（使核蛋白解离）",
        ]},
        { h: "相分离", items: [
          `加入 ${(v.trizolVolume || 1) * 0.2} mL 氯仿，剧烈振荡 15 s`,
          "室温静置 2~3 min（出现明显分层）",
          "12,000 rpm，4°C 离心 15 min",
          "小心吸取上层水相（~500 μL）至新管（勿触碰中间层/有机相）",
        ]},
        { h: "RNA 沉淀", items: [
          `加入 ${(v.trizolVolume || 1) * 0.5} mL 异丙醇，颠倒混匀`,
          "室温静置 10 min（或 −20°C 30 min 提高产量）",
          "12,000 rpm，4°C 离心 10 min，可见白色 RNA 沉淀",
          "小心弃上清（勿丢失沉淀）",
        ]},
        { h: "洗涤与溶解", items: [
          `加入 ${v.trizolVolume || 1} mL 75% 乙醇（DEPC 水配制），轻柔颠倒洗涤`,
          "7,500 rpm，4°C 离心 5 min",
          "弃乙醇，重复洗涤 1 次",
          "室温晾干 5~10 min（勿完全干燥，否则难溶解）",
          "加入 30~50 μL RNase-free H₂O，65°C 助溶 5 min（可选）",
        ]},
        ...(v.dnase !== "否" ? [{ h: "DNase I 处理", items: [
          "加入 1 μL DNase I + 相应 Buffer，37°C 孵育 15~30 min",
          "加入 EDTA 终止反应（或过柱纯化），65°C 10 min 灭活",
        ]}] : []),
        { h: "质量检测", items: [
          "NanoDrop：A260/A280 = 1.9~2.1，A260/A230 > 2.0",
          "1% 琼脂糖凝胶电泳（含甲醛/MOPS）：28S/18S ≈ 2:1，无明显拖尾",
          `预期产量：${v.sampleSource === "培养细胞" ? "5~20 μg / 10⁶ 细胞" : "视组织类型而定"}`,
          v.downstream === "RNA-seq" ? "RIN > 8.0（Agilent Bioanalyzer）" : "立即用于下游实验或 −80°C 保存",
        ]},
      ];
    },
    notes() {
      return [
        { type: "warning", text: "TRIzol 含苯酚和异硫氰酸胍，具腐蚀性和毒性。全程佩戴手套、护目镜，在通风橱内操作。" },
        { type: "warning", text: "氯仿为致癌物，必须在通风橱内操作，废液分类收集。" },
        { type: "note", text: "所有器具、枪头需 RNase-free（DEPC 水处理或购买无酶耗材），操作台面用乙醇擦拭。" },
        { type: "note", text: "吸取上清时宁可少取（~400 μL），也不要触碰中间层蛋白/基因组 DNA 界面。" },
        { type: "note", text: "RNA 沉淀勿完全干燥（变透明难溶），晾干至白色沉淀刚变透明即可。" },
      ];
    },
  },
];

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
