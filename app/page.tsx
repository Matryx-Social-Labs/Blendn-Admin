import Image from "next/image";
import Link from "next/link";


export default function Home() {
  return (
   <div>
    <div className="flex flex-col items-center justify-center h-screen">  
      <h1 className="text-4xl font-bold">Blendn</h1>
      <p className="text-gray-500">A Social Media App to meet new people around you.</p>
      <Link href="/dashboard" className="bg-blue-500 text-white px-4 py-2 rounded-md">Login</Link>
    </div>
   </div>
  );
}
