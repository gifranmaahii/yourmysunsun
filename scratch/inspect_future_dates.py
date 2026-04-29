import mysql.connector

def get_db():
    return mysql.connector.connect(
        host="localhost",
        user="root",
        password="",
        database="bengkel_depok",
        charset="utf8mb4"
    )

def main():
    db = get_db()
    cursor = db.cursor()
    
    print("Files causing 2026 dates:")
    cursor.execute("""
        SELECT notes, DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) 
        FROM stock_movements 
        WHERE created_at >= '2026-03-01'
        GROUP BY notes, month
    """)
    
    for row in cursor.fetchall():
        print(f"File: {row[0]} | Month: {row[1]} | Count: {row[2]}")
        
    cursor.close()
    db.close()

if __name__ == "__main__":
    main()
