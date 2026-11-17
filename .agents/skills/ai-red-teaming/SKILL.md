---
name: ai-red-teaming
description: Audit, attack, and defend AI systems: prompt injection (direct & indirect), jailbreaks, data poisoning, model inversion, tool abuse, SSRF, sandboxing, and defense-in-depth guardrails.
triggers: AI security, red teaming, prompt injection, jailbreak, adversarial testing, LLM vulnerabilities, guardrails, model defense, data leakage
---

# AI Red Teaming & Security Auditing

Audit, attack, and defend AI systems: prompt injection (direct & indirect), jailbreaks, data poisoning, model inversion, tool abuse, SSRF, sandboxing, and defense-in-depth guardrails.

## Core Disciplines & Decision Frameworks

When working in this domain:
1. **Define Objective & Constraints**: Identify throughput, latency, quality, and cost constraints before choosing architectures.
2. **Consult Reference Guides**: Review verified architectural references below to adopt proven patterns instead of ad-hoc implementations.
3. **Validate & Evaluate**: Establish measurable evaluation gates (offline benchmarks, automated grading, or red-team stress tests) at every step.

## Architectural References & Playbooks

This skill includes 64 detailed reference guides located in `references/`:

| Topic | Reference Guide | Summary |
| :--- | :--- | :--- |
| **Advanced Techniques** | [advanced-techniques.md](references/advanced-techniques.md) | The practice of AI Red Teaming itself will evolve. Future techniques may involve using AI adversaries to automatically discover complex vulnerabilities, deve... |
| **Adversarial Examples** | [adversarial-examples.md](references/adversarial-examples.md) | A core AI Red Teaming activity involves generating adversarial examples – inputs slightly perturbed to cause misclassification or bypass safety filters – to ... |
| **Adversarial Training** | [adversarial-training.md](references/adversarial-training.md) | AI Red Teamers evaluate the effectiveness of adversarial training as a defense. They test if models trained on adversarial examples are truly robust or if ne... |
| **Agentic AI Security** | [agentic-ai-security.md](references/agentic-ai-security.md) | As AI agents capable of autonomous action become more common, AI Red Teamers must test their unique security implications. This involves assessing risks rela... |
| **AI Security Fundamentals** | [ai-security-fundamentals.md](references/ai-security-fundamentals.md) | This covers the foundational concepts essential for AI Red Teaming, bridging traditional cybersecurity with AI-specific threats. An AI Red Teamer must unders... |
| **API Protection** | [api-protection.md](references/api-protection.md) | AI Red Teamers rigorously test the security of APIs providing access to AI models. They probe for OWASP API Top 10 vulnerabilities like broken authentication... |
| **Authentication** | [authentication.md](references/authentication.md) | AI Red Teamers test the authentication mechanisms controlling access to AI systems and APIs. They attempt to bypass logins, steal or replay API keys/tokens, ... |
| **Authorization** | [authorization.md](references/authorization.md) | AI Red Teamers test authorization controls to ensure that authenticated users can only access the AI features and data permitted by their roles/permissions. ... |
| **Automated vs Manual Testing** | [automated-vs-manual.md](references/automated-vs-manual.md) | AI Red Teaming typically employs a blend of automated tools (for large-scale scanning, fuzzing prompts, generating basic adversarial examples) and manual hum... |
| **Benchmark Datasets** | [benchmark-datasets.md](references/benchmark-datasets.md) | AI Red Teamers may use or contribute to benchmark datasets specifically designed to evaluate AI security. These datasets (like HackAprompt, SecBench, NYU CTF... |
| **Black Box Testing** | [black-box-testing.md](references/black-box-testing.md) | In AI Red Teaming, black-box testing involves probing the AI system with inputs and observing outputs without any knowledge of the model's architecture, trai... |
| **Code Injection** | [code-injection.md](references/code-injection.md) | AI Red Teamers test for code injection vulnerabilities specifically in the context of AI applications. This involves probing whether user input, potentially ... |
| **Conferences** | [conferences.md](references/conferences.md) | Attending major cybersecurity conferences (DEF CON, Black Hat, RSA) and increasingly specialized AI Safety/Security conferences allows AI Red Teamers to lear... |
| **Confidentiality, Integrity, Availability** | [confidentiality-integrity-availability.md](references/confidentiality-integrity-availability.md) | The CIA Triad is directly applicable in AI Red Teaming. Confidentiality tests focus on preventing leakage of training data or proprietary model details. Inte... |
| **Continuous Monitoring** | [continuous-monitoring.md](references/continuous-monitoring.md) | AI Red Teamers assess the effectiveness of continuous monitoring systems by attempting attacks and observing if detection mechanisms trigger appropriate aler... |
| **Continuous Testing** | [continuous-testing.md](references/continuous-testing.md) | Applying continuous testing principles to AI security involves integrating automated red teaming checks into the development pipeline (CI/CD). This allows fo... |
| **Countermeasures** | [countermeasures.md](references/countermeasures.md) | AI Red Teamers must also understand and test defenses against prompt hacking. This includes evaluating the effectiveness of input sanitization, output filter... |
| **CTF Challenges** | [ctf-challenges.md](references/ctf-challenges.md) | Capture The Flag competitions increasingly include AI/ML security challenges. Participating in CTFs (tracked on CTFtime) or platforms like picoCTF helps AI R... |
| **Custom Testing Scripts** | [custom-testing-scripts.md](references/custom-testing-scripts.md) | AI Red Teamers frequently write custom scripts (often in Python) to automate bespoke attacks, interact with specific AI APIs, generate complex prompt sequenc... |
| **Data Poisoning** | [data-poisoning.md](references/data-poisoning.md) | AI Red Teamers simulate data poisoning attacks by evaluating how introducing manipulated or mislabeled data into potential training or fine-tuning datasets c... |
| **Direct Injection** | [direct.md](references/direct.md) | Direct injection attacks occur when malicious instructions are inserted directly into the prompt input field by the user interacting with the LLM. AI Red Tea... |
| **Emerging Threats** | [emerging-threats.md](references/emerging-threats.md) | AI Red Teamers must stay informed about potential future threats enabled by more advanced AI, such as highly autonomous attack agents, AI-generated malware t... |
| **Ethical Considerations** | [ethical-considerations.md](references/ethical-considerations.md) | Ethical conduct is crucial for AI Red Teamers. While simulating attacks, they must operate within strict legal and ethical boundaries defined by rules of eng... |
| **Forums** | [forums.md](references/forums.md) | Engaging in online forums, mailing lists, Discord servers, or subreddits dedicated to AI security, adversarial ML, prompt engineering, or general cybersecuri... |
| **Generative Models** | [generative-models.md](references/generative-models.md) | AI Red Teamers focus heavily on generative models (like GANs and LLMs) due to their widespread use and unique risks. Understanding how they generate content ... |
| **Grey Box Testing** | [grey-box-testing.md](references/grey-box-testing.md) | Grey-box AI Red Teaming involves testing with partial knowledge of the system, such as knowing the model type (e.g., GPT-4), having access to some documentat... |
| **Indirect Injection** | [indirect.md](references/indirect.md) | Indirect injection involves embedding malicious prompts within external data sources that the LLM processes, such as websites, documents, or emails. AI Red T... |
| **Industry Credentials** | [industry-credentials.md](references/industry-credentials.md) | Beyond formal certifications, recognition in the AI Red Teaming field comes from practical achievements like finding significant vulnerabilities (responsible... |
| **Industry Standards** | [industry-standards.md](references/industry-standards.md) | As AI matures, AI Red Teamers will increasingly need to understand and test against emerging industry standards and regulations for AI safety, security, and ... |
| **Infrastructure Security** | [infrastructure-security.md](references/infrastructure-security.md) | AI Red Teamers assess the security posture of the infrastructure hosting AI models (cloud environments, servers, containers). They look for misconfigurations... |
| **Insecure Deserialization** | [insecure-deserialization.md](references/insecure-deserialization.md) | AI Red Teamers investigate if serialized objects used by the AI system (e.g., for saving model states, configurations, or transmitting data) can be manipulat... |
| **Introduction** | [introduction.md](references/introduction.md) | AI Red Teaming is the practice of simulating adversarial attacks against AI systems to proactively identify vulnerabilities, potential misuse scenarios, and ... |
| **Jailbreak Techniques** | [jailbreak-techniques.md](references/jailbreak-techniques.md) | Jailbreaking is a specific category of prompt hacking where the AI Red Teamer aims to bypass the LLM's safety and alignment training. They use techniques lik... |
| **Lab Environments** | [lab-environments.md](references/lab-environments.md) | AI Red Teamers need environments to practice attacking vulnerable systems safely. While traditional labs (HTB, THM, VulnHub) build general pentesting skills,... |
| **Large Language Models** | [large-language-models.md](references/large-language-models.md) | LLMs are a primary target for AI Red Teaming. Understanding their architecture (often Transformer-based), training processes (pre-training, fine-tuning), and... |
| **LLM Security Testing** | [llm-security-testing.md](references/llm-security-testing.md) | The core application area for many AI Red Teamers today involves specifically testing Large Language Models for vulnerabilities like prompt injection, jailbr... |
| **Model Inversion** | [model-inversion.md](references/model-inversion.md) | AI Red Teamers perform model inversion tests to assess if an attacker can reconstruct sensitive training data (like images, text snippets, or personal attrib... |
| **Model Vulnerabilities** | [model-vulnerabilities.md](references/model-vulnerabilities.md) | This category covers attacks and tests targeting the AI model itself, beyond the prompt interface. AI Red Teamers investigate inherent weaknesses in the mode... |
| **Model Weight Stealing** | [model-weight-stealing.md](references/model-weight-stealing.md) | AI Red Teamers assess the risk of attackers reconstructing or stealing the proprietary weights of a trained model, often through API query-based attacks. Tes... |
| **Monitoring Solutions** | [monitoring-solutions.md](references/monitoring-solutions.md) | AI Red Teamers interact with monitoring tools primarily to test their effectiveness (evasion) or potentially exploit vulnerabilities within them. Understandi... |
| **Neural Networks** | [neural-networks.md](references/neural-networks.md) | Understanding neural network architectures (layers, nodes, activation functions) is vital for AI Red Teamers. This knowledge allows for targeted testing, suc... |
| **Prompt Engineering** | [prompt-engineering.md](references/prompt-engineering.md) | For AI Red Teamers, prompt engineering is both a tool and a target. It's a tool for crafting inputs to test model boundaries and vulnerabilities (e.g., creat... |
| **Prompt Hacking** | [prompt-hacking.md](references/prompt-hacking.md) | Prompt hacking is a core technique for AI Red Teamers targeting LLMs. It involves crafting inputs (prompts) to manipulate the model into bypassing safety con... |
| **Prompt Injection** | [prompt-injection.md](references/prompt-injection.md) | Prompt injection is a critical vulnerability tested by AI Red Teamers. They attempt to insert instructions into the LLM's input that override its intended sy... |
| **Red Team Simulations** | [red-team-simulations.md](references/red-team-simulations.md) | Participating in or conducting structured red team simulations against AI systems (or components) provides the most realistic practice. This involves applyin... |
| **Reinforcement Learning** | [reinforcement-learning.md](references/reinforcement-learning.md) | Red teaming RL-based AI systems involves testing for vulnerabilities such as reward hacking (exploiting the reward function to induce unintended behavior), u... |
| **Remote Code Execution** | [remote-code-execution.md](references/remote-code-execution.md) | AI Red Teamers attempt to achieve RCE on systems hosting or interacting with AI models. This could involve exploiting vulnerabilities in the AI framework its... |
| **Reporting Tools** | [reporting-tools.md](references/reporting-tools.md) | AI Red Teamers use reporting techniques and potentially tools to clearly document their findings, including discovered vulnerabilities, successful exploit st... |
| **Research Groups** | [research-groups.md](references/research-groups.md) | Following and potentially contributing to research groups at universities (like CMU, Stanford, Oxford), non-profits (like OpenAI, Anthropic), or government b... |
| **Research Opportunities** | [research-opportunities.md](references/research-opportunities.md) | AI Red Teaming relies on ongoing research. Key areas needing further investigation include scalable methods for finding elusive vulnerabilities, understandin... |
| **Responsible Disclosure** | [responsible-disclosure.md](references/responsible-disclosure.md) | A critical practice for AI Red Teamers is responsible disclosure: privately reporting discovered AI vulnerabilities (e.g., a successful jailbreak, data leak ... |
| **Risk Management** | [risk-management.md](references/risk-management.md) | AI Red Teamers contribute to the AI risk management process by identifying and demonstrating concrete vulnerabilities. Findings from red team exercises infor... |
| **Robust Model Design** | [robust-model-design.md](references/robust-model-design.md) | AI Red Teamers assess whether choices made during model design (architecture selection, regularization techniques, ensemble methods) effectively contribute t... |
| **Role of Red Teams** | [role-of-red-teams.md](references/role-of-red-teams.md) | The role of an AI Red Team is to rigorously challenge AI systems from an adversarial perspective. They design and execute tests to uncover vulnerabilities re... |
| **Safety Filter Bypasses** | [safety-filter-bypasses.md](references/safety-filter-bypasses.md) | AI Red Teamers specifically target the safety mechanisms (filters, guardrails) implemented within or around an AI model. They test techniques like using syno... |
| **Specialized Courses** | [specialized-courses.md](references/specialized-courses.md) | Targeted training is crucial for mastering AI Red Teaming. Look for courses covering adversarial ML, prompt hacking, LLM security, ethical hacking for AI, an... |
| **Supervised Learning** | [supervised-learning.md](references/supervised-learning.md) | AI Red Teamers analyze systems built using supervised learning to probe for vulnerabilities like susceptibility to adversarial examples designed to cause mis... |
| **Testing Platforms** | [testing-platforms.md](references/testing-platforms.md) | Platforms used by AI Red Teamers range from general penetration testing OS distributions like Kali Linux to specific AI red teaming tools/frameworks like Mic... |
| **Threat Modeling** | [threat-modeling.md](references/threat-modeling.md) | AI Red Teams apply threat modeling to identify unique attack surfaces in AI systems, such as manipulating training data, exploiting prompt interfaces, attack... |
| **Unauthorized Access** | [unauthorized-access.md](references/unauthorized-access.md) | AI Red Teamers test if vulnerabilities in the AI system or its interfaces allow attackers to gain unauthorized access to data, functionalities, or underlying... |
| **Unsupervised Learning** | [unsupervised-learning.md](references/unsupervised-learning.md) | When red teaming AI systems using unsupervised learning (e.g., clustering algorithms), focus areas include assessing whether the discovered patterns reveal s... |
| **Vulnerability Assessment** | [vulnerability-assessment.md](references/vulnerability-assessment.md) | While general vulnerability assessment scans infrastructure, AI Red Teaming extends this to assess vulnerabilities specific to the AI model and its unique in... |
| **White Box Testing** | [white-box-testing.md](references/white-box-testing.md) | White-box testing in AI Red Teaming grants the tester full access to the model's internals (architecture, weights, training data, source code). This allows f... |
| **Why Red Team AI Systems?** | [why-red-team-ai-systems.md](references/why-red-team-ai-systems.md) | AI systems introduce novel risks beyond traditional software, such as emergent unintended capabilities, complex failure modes, susceptibility to subtle data ... |

## Usage Guidelines

- Read specific topics on-demand: consult `references/<topic>.md` when making architectural choices.
- Combine with related skills (`fine-tuning-expert`, `eval-harness`, `subagent-driven-development`, `security-reviewer`) for end-to-end execution.
