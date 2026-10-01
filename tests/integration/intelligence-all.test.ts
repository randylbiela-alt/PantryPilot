import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { calculateExpiring, calculateLowStock, calculateReadiness } from "../../src/intelligence.js";
const p=(name:string,quantity:number,unit:string,expirationDate:Date|null=null)=>({id:name,name,normalizedName:name.toLowerCase(),quantity:new Prisma.Decimal(quantity),unit,expirationDate});
describe("pantry intelligence",()=>{
  it("detects low stock",()=>expect(calculateLowStock([p("Eggs",3,"item")])[0]?.name).toBe("Eggs"));
  it("classifies expiring items",()=>{const today=new Date("2026-10-01T00:00:00.000Z");expect(calculateExpiring([p("Milk",1,"gal",new Date("2026-10-02T00:00:00.000Z"))],7,today)[0]?.priority).toBe("CRITICAL")});
  it("calculates readiness while consuming shared pantry",()=>{const recipe={id:"r",name:"Eggs",favorite:false,ingredients:[{name:"Eggs",quantity:new Prisma.Decimal(2),unit:"item"}]};const value=calculateReadiness([{id:"m1",recipe},{id:"m2",recipe}],[p("Eggs",3,"item")]);expect(value).toMatchObject({plannedMeals:2,cookableMeals:1,score:50})});
});
