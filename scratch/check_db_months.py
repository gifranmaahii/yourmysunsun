import mysql.connector
from datetime import datetime

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
    
    print("Stock Movements Count by Month:")
    print(f"{'Month':<10} | {'Type':<5} | {'Count':<5}")
    print("-" * 30)
    
    cursor.execute("""
        SELECT 
            DATE_FORMAT(created_at, '%Y-%m') as month, 
            type, 
            COUNT(*) as total 
        FROM stock_movements 
        GROUP BY month, type 
        ORDER BY month DESC, type ASC
    """)
    
    for row in cursor.fetchall():
        print(f"{row[0]:<10} | {row[1]:<5} | {row[2]:<5}")
        
    cursor.close()
    db.close()

if __name__ == "__main__":
    main()
