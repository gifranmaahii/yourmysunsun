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
    
    print("Invalid/Null Dates in stock_movements:")
    cursor.execute("""
        SELECT notes, COUNT(*) 
        FROM stock_movements 
        WHERE created_at IS NULL OR created_at = '0000-00-00 00:00:00'
        GROUP BY notes
    """)
    
    for row in cursor.fetchall():
        print(f"Notes: {row[0]} | Count: {row[1]}")
        
    cursor.close()
    db.close()

if __name__ == "__main__":
    main()
