/* The live GitLab application row (2026-10-08), ANONYMISED, as three jsonb values read from prod.
 *
 * Why this exists: every hand-written fixture carried tailor_refs.schema_version = 1, but the live
 * Gemini tailor never emits that key. The edit gate required it, so rebuildOriginal returned null on
 * every real row and the approval page said "Editing is off". Only a fixture shaped like the real row
 * can hold that regression shut.
 *
 * Anonymisation: names, contact details, links, employer, institutions and project names were replaced
 * by ONE string substitution applied identically to all three values (including the ref ids that named
 * the employer and institution). The validator checks every tailored bullet against the master, so a
 * substitution that drifted between them would fail the rebuild: the passing test is the consistency proof.
 * Everything else (ref structure, section_order, master_version 2, and the ABSENT schema_version in
 * TAILOR_REFS) is the live data unchanged. Do not "tidy" schema_version into TAILOR_REFS. */

// applications.tailor_refs: what the tailor stored. Note: no schema_version key, exactly as live.
export const TAILOR_REFS: Record<string, unknown> = {
  "skills": [
    {
      "ref": "skill_python"
    },
    {
      "ref": "skill_javascript"
    },
    {
      "ref": "skill_typescript"
    },
    {
      "ref": "skill_fastapi"
    },
    {
      "ref": "skill_nodejs"
    },
    {
      "ref": "skill_postgres"
    },
    {
      "ref": "skill_redis"
    },
    {
      "ref": "skill_docker"
    },
    {
      "ref": "skill_gcp"
    },
    {
      "ref": "skill_cicd"
    },
    {
      "ref": "skill_llm_apps"
    },
    {
      "ref": "skill_ai_agents"
    }
  ],
  "summary": {
    "refs": [
      "exp_acme",
      "proj_mentor",
      "skill_python",
      "skill_nodejs",
      "skill_postgres",
      "skill_docker"
    ],
    "text": "Software engineer with production experience building and scaling backend services, APIs, databases, and containerized architectures using Python, Node.js, PostgreSQL, Redis, and Docker on cloud platforms, with practical integration of AI tooling and automated CI/CD workflows."
  },
  "projects": [
    {
      "ref": "proj_mentor",
      "bullets": [
        {
          "ref": "bullet_mentor_backend",
          "text": "Developed backend services using PostgreSQL, Redis, REST APIs, JWT authentication, WebRTC, Socket.IO, rate limiting, and input validation."
        },
        {
          "ref": "bullet_mentor_devops",
          "text": "Designed and deployed scalable containerized services on Google Cloud Platform using Docker, Git, GitHub Actions, CI/CD, and YAML workflows, including blockchain-based certificate verification with SHA-256."
        }
      ]
    },
    {
      "ref": "proj_f1_predictor",
      "bullets": [
        {
          "ref": "bullet_f1_eda_deploy",
          "text": "Performed exploratory data analysis, applied SHAP for model explainability, and implemented CI/CD pipelines with GitHub Actions for FastAPI services exposing /predict, /health, and /info."
        }
      ]
    }
  ],
  "education": [
    {
      "ref": "edu_btech",
      "bullets": []
    }
  ],
  "experience": [
    {
      "ref": "exp_acme",
      "bullets": [
        {
          "ref": "bullet_acme_backend",
          "text": "Developed backend services, REST APIs, event-driven workflows, and AI orchestration pipelines using FastAPI, Node.js, PostgreSQL, Supabase, Docker, and Google Cloud Platform."
        },
        {
          "ref": "bullet_acme_rag",
          "text": "Integrated LLM APIs with RAG pipelines into Acme Assist, enabling AI-powered financial assistance, contextual business intelligence, and workflow automation."
        }
      ]
    }
  ],
  "achievements": [],
  "section_order": [
    "summary",
    "skills",
    "experience",
    "projects",
    "education",
    "certifications"
  ],
  "certifications": [
    {
      "ref": "cert_ibm_sql",
      "bullets": []
    }
  ],
  "master_version": 2
};

// applications.tailored_profile: the resume the validator resolved at tailoring time, the expected rebuild.
export const STORED_TAILORED_PROFILE: Record<string, unknown> = {
  "skills": [
    {
      "ref": "skill_python",
      "name": "Python",
      "category": "Languages"
    },
    {
      "ref": "skill_javascript",
      "name": "JavaScript",
      "category": "Languages"
    },
    {
      "ref": "skill_typescript",
      "name": "TypeScript",
      "category": "Languages"
    },
    {
      "ref": "skill_fastapi",
      "name": "FastAPI",
      "category": "Frameworks"
    },
    {
      "ref": "skill_nodejs",
      "name": "Node.js",
      "category": "Frameworks"
    },
    {
      "ref": "skill_postgres",
      "name": "PostgreSQL",
      "category": "Databases"
    },
    {
      "ref": "skill_redis",
      "name": "Redis",
      "category": "Databases"
    },
    {
      "ref": "skill_docker",
      "name": "Docker",
      "category": "DevOps & Cloud"
    },
    {
      "ref": "skill_gcp",
      "name": "Google Cloud Platform",
      "category": "DevOps & Cloud"
    },
    {
      "ref": "skill_cicd",
      "name": "CI/CD & GitHub Actions",
      "category": "DevOps & Cloud"
    },
    {
      "ref": "skill_llm_apps",
      "name": "LLM Applications",
      "category": "AI"
    },
    {
      "ref": "skill_ai_agents",
      "name": "AI Agents & Workflows",
      "category": "AI"
    }
  ],
  "summary": "Software engineer with production experience building and scaling backend services, APIs, databases, and containerized architectures using Python, Node.js, PostgreSQL, Redis, and Docker on cloud platforms, with practical integration of AI tooling and automated CI/CD workflows.",
  "identity": {
    "email": "candidate@example.com",
    "links": [
      {
        "id": "link_portfolio",
        "url": "https://example.com/portfolio",
        "label": "Portfolio"
      },
      {
        "id": "link_github",
        "url": "https://example.com/github",
        "label": "GitHub"
      },
      {
        "id": "link_linkedin",
        "url": "https://example.com/linkedin",
        "label": "LinkedIn"
      },
      {
        "id": "link_x",
        "url": "https://example.com/x",
        "label": "X"
      }
    ],
    "phone": "+00 0000000000",
    "headline": "Full Stack AI Engineer",
    "location": "Example City",
    "full_name": "Test Candidate"
  },
  "projects": [
    {
      "ref": "proj_mentor",
      "name": "Sample Mentorship Platform",
      "links": [
        {
          "id": "link_mentor_live",
          "url": "https://example.com/mentor-live",
          "label": "Live Demo"
        },
        {
          "id": "link_mentor_github",
          "url": "https://example.com/github",
          "label": "GitHub"
        }
      ],
      "bullets": [
        {
          "ref": "bullet_mentor_backend",
          "text": "Developed backend services using PostgreSQL, Redis, REST APIs, JWT authentication, WebRTC, Socket.IO, rate limiting, and input validation.",
          "master_text": "Developed backend services using PostgreSQL, Redis, REST APIs, JWT authentication, WebRTC, Socket.IO, rate limiting, and input validation."
        },
        {
          "ref": "bullet_mentor_devops",
          "text": "Designed and deployed scalable containerized services on Google Cloud Platform using Docker, Git, GitHub Actions, CI/CD, and YAML workflows, including blockchain-based certificate verification with SHA-256.",
          "master_text": "Designed and deployed scalable containerized services on Google Cloud Platform using Docker, Git, GitHub Actions, CI/CD, and YAML workflows, including blockchain-based certificate verification with SHA-256."
        }
      ],
      "end_display": "Present",
      "start_display": "Jan 2026"
    },
    {
      "ref": "proj_f1_predictor",
      "name": "F1 Race Pace Predictor",
      "links": [
        {
          "id": "link_f1_live",
          "url": "https://example.com/pace-live",
          "label": "Live Demo"
        },
        {
          "id": "link_f1_github",
          "url": "https://example.com/github",
          "label": "GitHub"
        }
      ],
      "bullets": [
        {
          "ref": "bullet_f1_eda_deploy",
          "text": "Performed exploratory data analysis, applied SHAP for model explainability, and implemented CI/CD pipelines with GitHub Actions for FastAPI services exposing /predict, /health, and /info.",
          "master_text": "Performed exploratory data analysis, applied SHAP for model explainability, and implemented CI/CD pipelines with GitHub Actions for FastAPI services exposing /predict, /health, and /info."
        }
      ],
      "end_display": "Jan 2026",
      "start_display": "Sep 2025"
    }
  ],
  "education": [
    {
      "ref": "edu_btech",
      "field": "Computer Science & Data Science (CSD)",
      "degree": "B.Tech",
      "bullets": [],
      "end_display": "2027",
      "institution": "Example Institute of Technology",
      "grade_display": null,
      "start_display": "2024"
    }
  ],
  "experience": [
    {
      "ref": "exp_acme",
      "role": "Full Stack AI Engineer",
      "bullets": [
        {
          "ref": "bullet_acme_backend",
          "text": "Developed backend services, REST APIs, event-driven workflows, and AI orchestration pipelines using FastAPI, Node.js, PostgreSQL, Supabase, Docker, and Google Cloud Platform.",
          "master_text": "Developed backend services, REST APIs, event-driven workflows, and AI orchestration pipelines using FastAPI, Node.js, PostgreSQL, Supabase, Docker, and Google Cloud Platform."
        },
        {
          "ref": "bullet_acme_rag",
          "text": "Integrated LLM APIs with RAG pipelines into Acme Assist, enabling AI-powered financial assistance, contextual business intelligence, and workflow automation.",
          "master_text": "Integrated LLM APIs with RAG pipelines into Acme Assist, enabling AI-powered financial assistance, contextual business intelligence, and workflow automation."
        }
      ],
      "company": "Acme Technologies",
      "location": "Example City",
      "end_display": "Present",
      "start_display": "May 2026"
    }
  ],
  "achievements": [],
  "section_order": [
    "summary",
    "skills",
    "experience",
    "projects",
    "education",
    "certifications"
  ],
  "certifications": [
    {
      "ref": "cert_ibm_sql",
      "label": "SQL and Relational Databases",
      "bullets": [],
      "description": "IBM Developer Skills Network"
    }
  ],
  "master_version": 2,
  "schema_version": 1
};

// master_profiles.profile for version 2: the master the refs resolve against.
export const MASTER_V2: Record<string, unknown> = {
  "links": [],
  "skills": [
    {
      "id": "skill_llm_apps",
      "name": "LLM Applications",
      "category": "AI"
    },
    {
      "id": "skill_rag",
      "name": "RAG Pipelines",
      "category": "AI"
    },
    {
      "id": "skill_prompt_eng",
      "name": "Prompt Engineering",
      "category": "AI"
    },
    {
      "id": "skill_context_eng",
      "name": "Context Engineering",
      "category": "AI"
    },
    {
      "id": "skill_ai_agents",
      "name": "AI Agents & Workflows",
      "category": "AI"
    },
    {
      "id": "skill_tool_calling",
      "name": "Tool Calling & Guardrails",
      "category": "AI"
    },
    {
      "id": "skill_python",
      "name": "Python",
      "category": "Languages"
    },
    {
      "id": "skill_sql",
      "name": "SQL",
      "category": "Languages"
    },
    {
      "id": "skill_javascript",
      "name": "JavaScript",
      "category": "Languages"
    },
    {
      "id": "skill_typescript",
      "name": "TypeScript",
      "category": "Languages"
    },
    {
      "id": "skill_fastapi",
      "name": "FastAPI",
      "category": "Frameworks"
    },
    {
      "id": "skill_nodejs",
      "name": "Node.js",
      "category": "Frameworks"
    },
    {
      "id": "skill_react",
      "name": "React.js",
      "category": "Frameworks"
    },
    {
      "id": "skill_langchain",
      "name": "LangChain",
      "category": "Frameworks"
    },
    {
      "id": "skill_postgres",
      "name": "PostgreSQL",
      "category": "Databases"
    },
    {
      "id": "skill_pgvector",
      "name": "pgvector",
      "category": "Databases"
    },
    {
      "id": "skill_redis",
      "name": "Redis",
      "category": "Databases"
    },
    {
      "id": "skill_docker",
      "name": "Docker",
      "category": "DevOps & Cloud"
    },
    {
      "id": "skill_gcp",
      "name": "Google Cloud Platform",
      "category": "DevOps & Cloud"
    },
    {
      "id": "skill_cicd",
      "name": "CI/CD & GitHub Actions",
      "category": "DevOps & Cloud"
    }
  ],
  "summary": {
    "id": "summary_main",
    "text": "Computer Science undergraduate specializing in Data Science with industry experience as a Full Stack AI Engineer. Experienced in building LLM-powered applications, RAG systems, AI agents, agentic workflows, and AI-driven automation for fintech and business applications. Proficient in Python, SQL, FastAPI, PostgreSQL, pgvector, JavaScript, Node.js, Docker, Google Cloud Platform, prompt engineering, context engineering, and AI orchestration."
  },
  "identity": {
    "email": "candidate@example.com",
    "links": [
      {
        "id": "link_portfolio",
        "url": "https://example.com/portfolio",
        "label": "Portfolio"
      },
      {
        "id": "link_github",
        "url": "https://example.com/github",
        "label": "GitHub"
      },
      {
        "id": "link_linkedin",
        "url": "https://example.com/linkedin",
        "label": "LinkedIn"
      },
      {
        "id": "link_x",
        "url": "https://example.com/x",
        "label": "X"
      }
    ],
    "phone": "+00 0000000000",
    "headline": "Full Stack AI Engineer",
    "location": "Example City",
    "full_name": "Test Candidate"
  },
  "projects": [
    {
      "id": "proj_mentor",
      "name": "Sample Mentorship Platform",
      "links": [
        {
          "id": "link_mentor_live",
          "url": "https://example.com/mentor-live",
          "label": "Live Demo"
        },
        {
          "id": "link_mentor_github",
          "url": "https://example.com/github",
          "label": "GitHub"
        }
      ],
      "bullets": [
        {
          "id": "bullet_mentor_fullstack",
          "tags": [
            "saas",
            "fullstack",
            "react"
          ],
          "text": "Built a full-stack SaaS platform for professional networking, personal branding, and secure one-on-one mentorship booking with free and paid sessions."
        },
        {
          "id": "bullet_mentor_backend",
          "tags": [
            "postgres",
            "redis",
            "webrtc",
            "auth"
          ],
          "text": "Developed backend services using PostgreSQL, Redis, REST APIs, JWT authentication, WebRTC, Socket.IO, rate limiting, and input validation."
        },
        {
          "id": "bullet_mentor_gemini",
          "tags": [
            "gemini",
            "prompting",
            "cost-optimization"
          ],
          "text": "Integrated Gemini API to build AI-powered application workflows using prompt builders, context builders, and token-cost optimization strategies."
        },
        {
          "id": "bullet_mentor_devops",
          "tags": [
            "docker",
            "gcp",
            "cicd",
            "sha256"
          ],
          "text": "Designed and deployed scalable containerized services on Google Cloud Platform using Docker, Git, GitHub Actions, CI/CD, and YAML workflows, including blockchain-based certificate verification with SHA-256."
        }
      ],
      "end_date": null,
      "start_date": "2026-01-01",
      "end_display": "Present",
      "start_display": "Jan 2026"
    },
    {
      "id": "proj_f1_predictor",
      "name": "F1 Race Pace Predictor",
      "links": [
        {
          "id": "link_f1_live",
          "url": "https://example.com/pace-live",
          "label": "Live Demo"
        },
        {
          "id": "link_f1_github",
          "url": "https://example.com/github",
          "label": "GitHub"
        }
      ],
      "bullets": [
        {
          "id": "bullet_f1_ml_system",
          "tags": [
            "ml",
            "telemetry"
          ],
          "text": "Built an end-to-end ML system predicting F1 driver race pace using qualifying and telemetry data with circuit-specific models for Austin, Mexico, Qatar, and Abu Dhabi."
        },
        {
          "id": "bullet_f1_models",
          "tags": [
            "xgboost",
            "gbr",
            "neural-networks"
          ],
          "text": "Trained Gradient Boosting Regressor, XGBoost Regressor, and Feed-Forward Neural Network models using MAE-based evaluation with extensive feature engineering and normalization."
        },
        {
          "id": "bullet_f1_eda_deploy",
          "tags": [
            "shap",
            "fastapi",
            "cicd"
          ],
          "text": "Performed exploratory data analysis, applied SHAP for model explainability, and implemented CI/CD pipelines with GitHub Actions for FastAPI services exposing /predict, /health, and /info."
        }
      ],
      "end_date": "2026-01-31",
      "start_date": "2025-09-01",
      "end_display": "Jan 2026",
      "start_display": "Sep 2025"
    }
  ],
  "education": [
    {
      "id": "edu_btech",
      "field": "Computer Science & Data Science (CSD)",
      "degree": "B.Tech",
      "bullets": [],
      "end_date": "2027-06-01",
      "start_date": "2024-08-01",
      "end_display": "2027",
      "institution": "Example Institute of Technology",
      "grade_display": null,
      "start_display": "2024"
    },
    {
      "id": "edu_diploma",
      "field": "Electronics & Communication (ECE)",
      "degree": "Diploma",
      "bullets": [],
      "end_date": "2024-05-01",
      "start_date": "2021-08-01",
      "end_display": "2024",
      "institution": "Sample College of Engineering",
      "grade_display": null,
      "start_display": "2021"
    }
  ],
  "experience": [
    {
      "id": "exp_acme",
      "role": "Full Stack AI Engineer",
      "bullets": [
        {
          "id": "bullet_acme_fintech",
          "tags": [
            "fintech",
            "gst",
            "automation"
          ],
          "text": "Contributed to the development of a fintech platform covering GST compliance, GST filing, banking, accounting, invoicing, and workflow automation modules."
        },
        {
          "id": "bullet_acme_rag",
          "tags": [
            "llm",
            "rag",
            "fintech"
          ],
          "text": "Integrated LLM APIs with RAG pipelines into Acme Assist, enabling AI-powered financial assistance, contextual business intelligence, and workflow automation."
        },
        {
          "id": "bullet_acme_agents",
          "tags": [
            "agents",
            "workflows",
            "automation"
          ],
          "text": "Built AI agents and multi-step agentic workflows for lead enrichment, accounting assistance, customer engagement, social media automation, and business process optimization."
        },
        {
          "id": "bullet_acme_backend",
          "tags": [
            "fastapi",
            "nodejs",
            "postgres",
            "docker",
            "gcp"
          ],
          "text": "Developed backend services, REST APIs, event-driven workflows, and AI orchestration pipelines using FastAPI, Node.js, PostgreSQL, Supabase, Docker, and Google Cloud Platform."
        }
      ],
      "company": "Acme Technologies",
      "end_date": null,
      "location": "Example City",
      "start_date": "2026-05-01",
      "end_display": "Present",
      "start_display": "May 2026"
    },
    {
      "id": "exp_student_club",
      "role": "Technical Coordinator",
      "bullets": [
        {
          "id": "bullet_st_hackathons",
          "tags": [
            "leadership",
            "hackathons"
          ],
          "text": "Organized and hosted 2+ hackathons and technical workshops with 340+ student attendees, led a 9-member technical team, and mentored 90+ project teams."
        }
      ],
      "company": "Example Student Club",
      "end_date": "2026-02-28",
      "location": "Example City",
      "start_date": "2024-11-01",
      "end_display": "Feb 2026",
      "start_display": "Nov 2024"
    }
  ],
  "achievements": [
    {
      "id": "ach_leetcode",
      "label": "LeetCode",
      "bullets": [
        {
          "id": "bullet_ach_leetcode",
          "tags": [
            "dsa",
            "leetcode"
          ],
          "text": "Solved 200+ problems on LeetCode covering Data Structures & Algorithms"
        }
      ]
    },
    {
      "id": "ach_hackathon",
      "label": "Build With India Hackathon",
      "bullets": [
        {
          "id": "bullet_ach_hackathon",
          "tags": [
            "hackathon",
            "ml"
          ],
          "text": "Ranked in the top 20% among 25,000 teams and cleared 6 of 7 rounds with real-time crop-price prediction application"
        }
      ]
    }
  ],
  "certifications": [
    {
      "id": "cert_ibm_sql",
      "label": "SQL and Relational Databases",
      "bullets": [],
      "description": "IBM Developer Skills Network"
    },
    {
      "id": "cert_prompt_eng",
      "label": "Prompt Engineering",
      "bullets": [],
      "description": "Cognitive Class.ai"
    },
    {
      "id": "cert_ibm_ml",
      "label": "Machine Learning",
      "bullets": [],
      "description": "IBM SkillsBuild"
    }
  ],
  "schema_version": 1
};

// The pin recorded on the row; the validator refuses any other version.
export const MASTER_VERSION = 2;
