# MariaDB (SkySQL) Connection & Persistent Storage Guide

এই গাইডে তোমার দেওয়া SkySQL MariaDB endpoint এ connect করা, database/table তৈরি করা, এবং application data যেন সবসময় persistent থাকে সেটা step-by-step দেখানো হলো।

## 1) Prerequisites

- MariaDB client install থাকতে হবে (`mariadb` command)।
- তোমার account password লাগবে (তুমি `-p` দিলে prompt আসবে)।

## 2) Connect Command

```bash
mariadb \
  --host serverless-us-central1.sysp0000.db2.skysql.com \
  --port 4016 \
  --user dbpgf37955378 \
  -p \
  --ssl-verify-server-cert
```

> `Enter password:` এ password দিলে login হবে।

## 3) Initial SQL Setup (DB + tables)

login হওয়ার পরে নিচের SQL run করো:

```sql
CREATE DATABASE IF NOT EXISTS qm_app
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE qm_app;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('student','teacher','admin') NOT NULL DEFAULT 'student',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exams (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  subject VARCHAR(120) NULL,
  total_marks DECIMAL(6,2) NOT NULL DEFAULT 0,
  exam_date DATETIME NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_exams_created_by
    FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS questions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  exam_id BIGINT UNSIGNED NOT NULL,
  question_text TEXT NOT NULL,
  option_a VARCHAR(255) NOT NULL,
  option_b VARCHAR(255) NOT NULL,
  option_c VARCHAR(255) NOT NULL,
  option_d VARCHAR(255) NOT NULL,
  correct_option ENUM('A','B','C','D') NOT NULL,
  marks DECIMAL(5,2) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_questions_exam
    FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS student_submissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  exam_id BIGINT UNSIGNED NOT NULL,
  student_id BIGINT UNSIGNED NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  score DECIMAL(6,2) NULL,
  status ENUM('submitted','evaluated') NOT NULL DEFAULT 'submitted',
  CONSTRAINT fk_submissions_exam
    FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_submissions_student
    FOREIGN KEY (student_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE KEY uq_exam_student (exam_id, student_id)
) ENGINE=InnoDB;
```

## 4) Keep all data persistent (best practices)

1. **InnoDB only** ব্যবহার করো (transactions + crash recovery)।
2. `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE` constraints ব্যবহার করো data consistency এর জন্য।
3. Application থেকে raw password না রেখে **password_hash** store করো (bcrypt/argon2)।
4. Backup policy রাখো:
   - daily logical backup (`mysqldump`)
   - periodic restore test
5. Migration versioning চালু করো (যেমন: Flyway / Liquibase / Prisma migrate / Alembic)।
6. Production এ direct table edit না করে migration/script use করো।

## 5) Quick backup / restore commands

### Backup
```bash
mysqldump \
  --host serverless-us-central1.sysp0000.db2.skysql.com \
  --port 4016 \
  --user dbpgf37955378 \
  -p \
  --ssl-verify-server-cert \
  --single-transaction \
  qm_app > qm_app_backup.sql
```

### Restore
```bash
mariadb \
  --host serverless-us-central1.sysp0000.db2.skysql.com \
  --port 4016 \
  --user dbpgf37955378 \
  -p \
  --ssl-verify-server-cert \
  qm_app < qm_app_backup.sql
```

## 6) Application configuration (.env example)

```env
DB_HOST=serverless-us-central1.sysp0000.db2.skysql.com
DB_PORT=4016
DB_USER=dbpgf37955378
DB_PASSWORD=your_password_here
DB_NAME=qm_app
DB_SSL=true
```

> Password কখনো git repo তে commit করো না।

## 7) Verify everything saved correctly

```sql
USE qm_app;
SHOW TABLES;
SELECT COUNT(*) AS total_users FROM users;
SELECT COUNT(*) AS total_exams FROM exams;
SELECT COUNT(*) AS total_submissions FROM student_submissions;
```

যদি এগুলো কাজ করে, তাহলে connection + schema + persistence setup ঠিক আছে।


## 8) One-command setup from this repo

এই repo-তে automation দেওয়া আছে:

- `sql/init_qm_app.sql` → schema SQL
- `scripts/run_skysql_setup.sh` → one-command setup runner

Run:

```bash
export DB_PASSWORD='.M9xtp{wYgCsAEbjZRl16MKio'
./scripts/run_skysql_setup.sh
```

## 9) If `mariadb` command is missing

Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y mariadb-client
```

তারপর আবার script run করো।
